/**
 * PDF AI Analysis Controller
 *
 * Endpoints for triggering AI-powered issue analysis, retrieving suggestions,
 * approving/rejecting suggestions, and applying fixes to PDF files.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../utils/app-error';
import { aiAnalysisService, AiRemediationConfig } from '../services/pdf/ai-analysis.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { pdfModifierService } from '../services/pdf/pdf-modifier.service';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const triggerSchema = z.object({
  overrides: z
    .object({
      tableFixMode: z.enum(['apply-to-pdf', 'guidance-only', 'summaries-to-pdf-headers-as-guidance']).optional(),
      altTextMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
      listMode: z.enum(['auto-resolve-decorative', 'guidance-only']).optional(),
      languageMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
      colorContrastMode: z.enum(['guidance-only', 'disabled']).optional(),
      linkTextMode: z.enum(['guidance-only', 'disabled']).optional(),
      formFieldMode: z.enum(['guidance-only', 'disabled']).optional(),
      bookmarkMode: z.enum(['guidance-only', 'disabled']).optional(),
      confidenceThreshold: z.number().min(0.5).max(0.95).optional(),
      autoApplyHighConfidence: z.boolean().optional(),
    })
    .optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

// ─── Controller ──────────────────────────────────────────────────────────────

export class PdfAiAnalysisController {
  /**
   * POST /pdf/:jobId/ai-analysis
   * Trigger AI analysis for all issues in a completed audit job.
   * Processing runs asynchronously; returns 202 immediately.
   */
  async triggerAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const { tenantId } = req.user;

      const parsed = triggerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw AppError.badRequest('Invalid request body: ' + parsed.error.message);
      }

      const overrides = parsed.data.overrides as Partial<AiRemediationConfig> | undefined;

      // Count eligible issues in the job output
      const output = (job.output ?? {}) as Record<string, unknown>;
      const auditReport = output.auditReport as Record<string, unknown> | undefined;
      const issues = (auditReport?.issues as unknown[]) ?? [];

      // Fire-and-forget — client polls GET endpoint for results
      aiAnalysisService
        .analyzeJob(job.id, tenantId, overrides)
        .then(({ analyzed, skipped }) => {
          logger.info(`[AI Analysis] Job ${job.id} complete: ${analyzed} analyzed, ${skipped} skipped`);
        })
        .catch((err: unknown) => {
          logger.error(
            `[AI Analysis] Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });

      res.status(202).json({
        success: true,
        data: {
          status: 'processing',
          total: issues.length,
          message: 'AI analysis started. Poll GET /pdf/:jobId/ai-analysis for results.',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/ai-analysis
   * Retrieve all AI suggestions for a job.
   */
  async getAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const jobId = req.job!.id;

      const suggestions = await prisma.aiAnalysis.findMany({
        where: { jobId },
        orderBy: { createdAt: 'asc' },
      });

      const analyzed = suggestions.length;
      const status = aiAnalysisService.isAnalyzing(jobId) ? 'processing' : 'complete';

      res.json({
        success: true,
        data: {
          suggestions,
          analyzed,
          status,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /pdf/:jobId/ai-analysis/:issueId
   * Update the status of a suggestion (approved | rejected).
   */
  async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const jobId = req.job!.id;
      const { issueId } = req.params;

      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        throw AppError.badRequest('Invalid request body: ' + parsed.error.message);
      }

      const existing = await prisma.aiAnalysis.findUnique({
        where: { jobId_issueId: { jobId, issueId } },
      });

      if (!existing) {
        throw AppError.notFound('AI analysis record not found');
      }

      const updated = await prisma.aiAnalysis.update({
        where: { jobId_issueId: { jobId, issueId } },
        data: { status: parsed.data.status, updatedAt: new Date() },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/ai-analysis/:issueId/apply
   * Apply a single approved AI suggestion to the PDF.
   */
  async applySuggestion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const { issueId } = req.params;
      const jobId = job.id;

      const analysis = await prisma.aiAnalysis.findUnique({
        where: { jobId_issueId: { jobId, issueId } },
      });

      if (!analysis) throw AppError.notFound('AI analysis record not found');
      if (analysis.applyMode === 'guidance-only') {
        throw AppError.badRequest('This suggestion is guidance-only and cannot be applied to the PDF');
      }
      if (!analysis.value) {
        throw AppError.badRequest('This suggestion has no value to apply');
      }

      // Load PDF (remediated version if available, else original)
      const output = (job.output ?? {}) as Record<string, unknown>;
      const fileName = (output.fileName as string | undefined) ?? 'document.pdf';

      let pdfBuffer = await fileStorageService.getRemediatedFile(jobId, fileName).catch(() => null);
      if (!pdfBuffer) {
        pdfBuffer = await fileStorageService.getFile(jobId, fileName);
      }
      if (!pdfBuffer) throw AppError.notFound('PDF file not found in storage');

      const doc = await pdfModifierService.loadPDF(pdfBuffer);

      // Apply modification based on suggestionType
      let modification;
      const { suggestionType, value } = analysis;

      // Resolve the element ID (imageId / tableId) from the original audit issue
      const auditReport = (output.auditReport ?? {}) as Record<string, unknown>;
      const auditIssues = (auditReport.issues ?? []) as Array<{ id: string; element?: string }>;
      const originalIssue = auditIssues.find((i) => i.id === issueId);
      const elementId = originalIssue?.element ?? issueId;
      logger.info(`[ApplySuggestion] issueId=${issueId} element=${elementId} type=${suggestionType}`);

      if (suggestionType === 'alt-text' || suggestionType === 'alt-text-improvement') {
        modification = await pdfModifierService.setAltText(doc, elementId, value);
      } else if (suggestionType === 'table-summary') {
        modification = await pdfModifierService.setTableSummary(doc, elementId, value);
      } else if (suggestionType === 'language') {
        modification = await pdfModifierService.addLanguage(doc, value);
      } else {
        throw AppError.badRequest(`suggestionType "${suggestionType}" cannot be applied to PDF`);
      }

      if (!modification.success) {
        logger.error(`[ApplySuggestion] setAltText failed: ${modification.error}`);
        throw AppError.internal(modification.error ?? 'Failed to apply modification');
      }

      // Save modified PDF
      const modifiedBuffer = await pdfModifierService.savePDF(doc);
      await fileStorageService.saveRemediatedFile(jobId, fileName, modifiedBuffer);

      // Update status to applied
      await prisma.aiAnalysis.update({
        where: { jobId_issueId: { jobId, issueId } },
        data: { status: 'applied', updatedAt: new Date() },
      });

      logger.info(`[AI Analysis] Applied ${suggestionType} for issue ${issueId} in job ${jobId}`);

      res.json({
        success: true,
        data: { modification, status: 'applied' },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/ai-analysis/apply-all
   * Apply all approved apply-to-pdf suggestions in a single PDF pass.
   */
  async applyAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const jobId = job.id;

      const approved = await prisma.aiAnalysis.findMany({
        where: {
          jobId,
          status: 'approved',
          applyMode: 'apply-to-pdf',
        },
        orderBy: { createdAt: 'asc' },
      });

      if (approved.length === 0) {
        res.json({
          success: true,
          data: { applied: 0, failed: 0, message: 'No approved suggestions to apply' },
        });
        return;
      }

      // Load PDF once
      const output = (job.output ?? {}) as Record<string, unknown>;
      const fileName = (output.fileName as string | undefined) ?? 'document.pdf';

      let pdfBuffer = await fileStorageService.getRemediatedFile(jobId, fileName).catch(() => null);
      if (!pdfBuffer) {
        pdfBuffer = await fileStorageService.getFile(jobId, fileName);
      }
      if (!pdfBuffer) throw AppError.notFound('PDF file not found in storage');

      const doc = await pdfModifierService.loadPDF(pdfBuffer);

      // Build element-ID lookup from original audit issues (mirrors applySuggestion fix for #241)
      const auditReport = (output.auditReport ?? {}) as Record<string, unknown>;
      const auditIssues = (auditReport.issues ?? []) as Array<{ id: string; element?: string }>;
      const elementById = new Map(auditIssues.map(i => [i.id, i.element ?? i.id]));

      let applied = 0;
      let failed = 0;

      for (const analysis of approved) {
        if (!analysis.value) {
          failed++;
          continue;
        }

        try {
          let modification;
          const { suggestionType, value, issueId } = analysis;
          const elementId = elementById.get(issueId) ?? issueId;

          if (suggestionType === 'alt-text' || suggestionType === 'alt-text-improvement') {
            modification = await pdfModifierService.setAltText(doc, elementId, value);
          } else if (suggestionType === 'table-summary') {
            modification = await pdfModifierService.setTableSummary(doc, elementId, value);
          } else if (suggestionType === 'language') {
            modification = await pdfModifierService.addLanguage(doc, value);
          } else {
            failed++;
            continue;
          }

          if (modification.success) {
            applied++;
            await prisma.aiAnalysis.update({
              where: { jobId_issueId: { jobId, issueId } },
              data: { status: 'applied', updatedAt: new Date() },
            });
          } else {
            failed++;
            logger.warn(`[AI Analysis] apply-all: failed to apply ${suggestionType} for ${issueId}: ${modification.error}`);
          }
        } catch (err) {
          failed++;
          logger.warn(`[AI Analysis] apply-all: error for ${analysis.issueId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Save modified PDF once regardless of partial failures
      if (applied > 0) {
        const modifiedBuffer = await pdfModifierService.savePDF(doc);
        await fileStorageService.saveRemediatedFile(jobId, fileName, modifiedBuffer);
      }

      logger.info(`[AI Analysis] apply-all for job ${jobId}: ${applied} applied, ${failed} failed`);

      res.json({
        success: true,
        data: { applied, failed },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAiAnalysisController = new PdfAiAnalysisController();
