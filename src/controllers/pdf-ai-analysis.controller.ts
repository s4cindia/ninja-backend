/**
 * PDF AI Analysis Controller
 *
 * Endpoints for triggering AI-powered issue analysis, retrieving suggestions,
 * approving/rejecting suggestions, and applying fixes to PDF files.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../utils/app-error';
import { aiAnalysisService, AiRemediationConfig } from '../services/pdf/ai-analysis.service';
import { adobeAutoTagService } from '../services/pdf/adobe-autotag.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { pdfModifierService } from '../services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../services/pdf/pdf-structure-writer.service';
import { pdfReauditService } from '../services/pdf/pdf-reaudit.service';
import type { AuditIssue } from '../services/audit/base-audit.service';
import { aiConfig } from '../config/ai.config';

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
      const output = (req.job!.output ?? {}) as Record<string, unknown>;
      const stats = (output.aiAnalysisStats as Record<string, unknown> | undefined) ?? null;
      // 'pending'    → AI hasn't started yet (no stats written, not in analysing set)
      // 'processing' → currently running
      // 'complete'   → aiAnalysisStats written to job.output (source of truth)
      const status = aiAnalysisService.isAnalyzing(jobId)
        ? 'processing'
        : stats
          ? 'complete'
          : 'pending';

      res.json({
        success: true,
        data: {
          suggestions,
          analyzed,
          status,
          stats,
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
      const { suggestionType } = analysis;
      // Allow caller to override the stored value (e.g. user-edited alt text)
      const value = (req.body as { value?: string }).value ?? analysis.value;

      // Resolve the element ID / original issue from the audit report
      const auditReport = (output.auditReport ?? {}) as Record<string, unknown>;
      const auditIssues = (auditReport.issues ?? []) as AuditIssue[];
      const originalIssue = auditIssues.find((i) => i.id === issueId) ?? { id: issueId } as AuditIssue;
      const elementId = originalIssue.element ?? issueId;
      logger.info(`[ApplySuggestion] issueId=${issueId} element=${elementId} type=${suggestionType}`);

      // Structure-writer operations — algorithmic, no value required
      if (suggestionType === 'heading-fix') {
        const results = pdfStructureWriterService.fixHeadingHierarchy(doc, [originalIssue]);
        const r = results[0];
        modification = { success: r.success, description: r.after, error: r.error };
      } else if (suggestionType === 'list-fix') {
        const results = pdfStructureWriterService.rewrapListItems(doc, [originalIssue]);
        const r = results[0];
        modification = { success: r.success, description: r.after, error: r.error };
      } else if (suggestionType === 'table-header-fix') {
        const results = pdfStructureWriterService.fixSimpleTableHeaders(doc, [originalIssue]);
        const r = results[0];
        modification = { success: r.success, description: r.after, error: r.error };
      } else if (suggestionType === 'bookmark-generate') {
        const result = pdfStructureWriterService.generateBookmarksFromHeadings(doc);
        modification = {
          success: result.generated > 0,
          description: `Generated ${result.generated} bookmark(s) from heading structure`,
          error: result.generated === 0 ? 'No headings found to generate bookmarks from' : undefined,
        };
      } else {
        // Value-based operations
        if (!value) throw AppError.badRequest('This suggestion has no value to apply');

        if (suggestionType === 'alt-text' || suggestionType === 'alt-text-improvement') {
          modification = await pdfModifierService.setAltText(doc, elementId, value);
        } else if (suggestionType === 'table-summary') {
          modification = await pdfModifierService.setTableSummary(doc, elementId, value);
        } else if (suggestionType === 'language') {
          modification = await pdfModifierService.addLanguage(doc, value);
        } else {
          throw AppError.badRequest(`suggestionType "${suggestionType}" cannot be applied to PDF`);
        }
      }

      if (!modification.success) {
        logger.warn(`[ApplySuggestion] modification failed: ${modification.error}`);
        throw AppError.unprocessable(modification.error ?? 'Failed to apply modification');
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

      // Build element-ID and issue-object lookup from original audit report
      const auditReport = (output.auditReport ?? {}) as Record<string, unknown>;
      const auditIssues = (auditReport.issues ?? []) as AuditIssue[];
      const elementById = new Map(auditIssues.map(i => [i.id, i.element ?? i.id]));
      const issueById = new Map(auditIssues.map(i => [i.id, i]));

      // Structure writer types are algorithmic — they don't require a value field
      const STRUCTURE_WRITER_TYPES = new Set(['heading-fix', 'list-fix', 'table-header-fix', 'bookmark-generate']);

      let applied = 0;
      let failed = 0;

      for (const analysis of approved) {
        const { suggestionType, value, issueId } = analysis;

        // Skip value-less non-structure-writer suggestions
        if (!value && !STRUCTURE_WRITER_TYPES.has(suggestionType)) {
          failed++;
          continue;
        }

        try {
          let modification;
          const elementId = elementById.get(issueId) ?? issueId;
          const originalIssue = issueById.get(issueId) ?? ({ id: issueId } as AuditIssue);

          if (suggestionType === 'heading-fix') {
            const results = pdfStructureWriterService.fixHeadingHierarchy(doc, [originalIssue]);
            const r = results[0];
            modification = { success: r.success, description: r.after, error: r.error };
          } else if (suggestionType === 'list-fix') {
            const results = pdfStructureWriterService.rewrapListItems(doc, [originalIssue]);
            const r = results[0];
            modification = { success: r.success, description: r.after, error: r.error };
          } else if (suggestionType === 'table-header-fix') {
            const results = pdfStructureWriterService.fixSimpleTableHeaders(doc, [originalIssue]);
            const r = results[0];
            modification = { success: r.success, description: r.after, error: r.error };
          } else if (suggestionType === 'bookmark-generate') {
            const result = pdfStructureWriterService.generateBookmarksFromHeadings(doc);
            modification = {
              success: result.generated > 0,
              description: `Generated ${result.generated} bookmark(s)`,
              error: result.generated === 0 ? 'No headings found' : undefined,
            };
          } else if (suggestionType === 'alt-text' || suggestionType === 'alt-text-improvement') {
            modification = await pdfModifierService.setAltText(doc, elementId, value!);
          } else if (suggestionType === 'table-summary') {
            modification = await pdfModifierService.setTableSummary(doc, elementId, value!);
          } else if (suggestionType === 'language') {
            modification = await pdfModifierService.addLanguage(doc, value!);
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

        // Set postRemediationStatus = 'pending' immediately so ACR button can gate on it
        const currentOutput = (job.output ?? {}) as Record<string, unknown>;
        await prisma.job.update({
          where: { id: jobId },
          data: { output: { ...currentOutput, postRemediationStatus: 'pending' } as Prisma.InputJsonObject },
        });

        // Fire-and-forget: re-audit after saves complete
        pdfReauditService.reauditAndCompare(jobId, modifiedBuffer, fileName)
          .then(async (comparison) => {
            const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
            const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
            const { resolvedCount, remainingCount, regressionCount, resolutionRate } = comparison.metrics;
            await prisma.job.update({
              where: { id: jobId },
              data: {
                output: {
                  ...latestOutput,
                  postRemediationStatus: 'complete',
                  postRemediationAudit: {
                    runAt: new Date().toISOString(),
                    resolved: resolvedCount,
                    remaining: remainingCount,
                    regressions: regressionCount,
                    resolutionRate,
                  },
                } as Prisma.InputJsonObject,
              },
            });
            logger.info(`[ApplyAll] Post-remediation re-audit complete for job ${jobId}: ${resolvedCount} resolved, ${regressionCount} regressions`);
          })
          .catch(async (err) => {
            logger.warn(`[ApplyAll] Post-remediation re-audit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            try {
              const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
              const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
              await prisma.job.update({
                where: { id: jobId },
                data: { output: { ...latestOutput, postRemediationStatus: 'failed' } as Prisma.InputJsonObject },
              });
            } catch { /* non-fatal — status update failure should not surface */ }
          });
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

  // ─── Auto-Tag Endpoints ───────────────────────────────────────────────────

  /**
   * POST /pdf/:jobId/auto-tag
   * Retry Adobe AutoTag for a job whose auto-tag previously failed.
   * Fire-and-forget — returns 202 immediately.
   */
  async retryAutoTag(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      if (!aiConfig.adobe.enabled) {
        res.status(503).json({ success: false, error: { code: 'ADOBE_NOT_CONFIGURED', message: 'Adobe PDF Services credentials are not configured.' } });
        return;
      }

      const job = req.job!;
      const jobId = job.id;
      const output = (job.output ?? {}) as Record<string, unknown>;
      const fileName = (output.fileName as string | undefined) ?? 'document.pdf';
      const currentStatus = output.autoTagStatus as string | undefined;

      if (currentStatus === 'complete') {
        res.status(400).json({ success: false, error: { code: 'ALREADY_TAGGED', message: 'Auto-tag already completed successfully.' } });
        return;
      }

      // Mark as processing immediately
      await prisma.job.update({
        where: { id: jobId },
        data: { output: { ...output, autoTagStatus: 'processing' } as Prisma.InputJsonObject },
      });

      // Fire-and-forget
      (async () => {
        try {
          const fileBuffer = await fileStorageService.getFile(jobId, fileName);
          if (!fileBuffer) throw new Error('PDF file not found in storage');

          const autoTagResult = await adobeAutoTagService.tagPdf(fileBuffer, { generateReport: true, exportWord: true });

          await fileStorageService.saveRemediatedFile(jobId, fileName, autoTagResult.taggedPdfBuffer);
          if (autoTagResult.reportBuffer) {
            await fileStorageService.saveFile(jobId, 'autotag-report.xlsx', autoTagResult.reportBuffer);
          }
          if (autoTagResult.wordBuffer) {
            const docxName = fileName.replace(/\.pdf$/i, '.docx');
            await fileStorageService.saveFile(jobId, docxName, autoTagResult.wordBuffer);
          }

          const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
          const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
          await prisma.job.update({
            where: { id: jobId },
            data: {
              output: {
                ...latestOutput,
                autoTagStatus: 'complete',
                hasTaggingReport: !!autoTagResult.reportBuffer,
                hasWordExport: !!autoTagResult.wordBuffer,
                autoTagElementCounts: autoTagResult.elementCounts,
              } as Prisma.InputJsonObject,
            },
          });
          logger.info(`[AutoTag Retry] Job ${jobId}: auto-tag complete`);
        } catch (err) {
          logger.error(`[AutoTag Retry] Job ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
          const latestJob = await prisma.job.findUnique({ where: { id: jobId } }).catch(() => null);
          const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
          await prisma.job.update({
            where: { id: jobId },
            data: { output: { ...latestOutput, autoTagStatus: 'failed', autoTagError: err instanceof Error ? err.message : String(err) } as Prisma.InputJsonObject },
          }).catch(() => {});
        }
      })();

      res.status(202).json({ success: true, data: { status: 'processing', message: 'Auto-tag retry started.' } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/auto-tag/status
   * Returns the current auto-tag status stored in job.output.
   */
  async getAutoTagStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const job = req.job!;
      const output = (job.output ?? {}) as Record<string, unknown>;
      const input = (job.input ?? {}) as Record<string, unknown>;
      const autoTagProgress = (input.autoTagProgress ?? {}) as Record<string, unknown>;
      res.json({
        success: true,
        data: {
          status: (output.autoTagStatus as string | undefined) ?? 'unknown',
          error: output.autoTagError as string | undefined,
          hasTaggingReport: (output.hasTaggingReport as boolean | undefined) ?? false,
          hasWordExport: (output.hasWordExport as boolean | undefined) ?? false,
          elementCounts: output.autoTagElementCounts ?? null,
          adobeFlags: (autoTagProgress.adobeFlags as unknown[] | undefined) ?? [],
          postRemediationStatus: output.postRemediationStatus as string | undefined,
          postRemediationAudit: output.postRemediationAudit as Record<string, unknown> | undefined,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/auto-tag/report
   * Stream the Adobe tagging report XML from storage.
   */
  async getTaggingReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const job = req.job!;
      const output = (job.output ?? {}) as Record<string, unknown>;
      if (!output.hasTaggingReport) throw AppError.notFound('Tagging report not available for this job.');

      const reportBuffer = await fileStorageService.getFile(job.id, 'autotag-report.xlsx');
      if (!reportBuffer) throw AppError.notFound('Tagging report file not found in storage.');

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="autotag-report.xlsx"');
      res.send(reportBuffer);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/auto-tag/word
   * Stream the Word (.docx) export from storage.
   */
  async downloadWord(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const job = req.job!;
      const output = (job.output ?? {}) as Record<string, unknown>;
      if (!output.hasWordExport) throw AppError.notFound('Word export not available for this job.');

      const fileName = (output.fileName as string | undefined) ?? 'document.pdf';
      const docxName = fileName.replace(/\.pdf$/i, '.docx');

      const wordBuffer = await fileStorageService.getFile(job.id, docxName);
      if (!wordBuffer) throw AppError.notFound('Word export file not found in storage.');

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${docxName}"`);
      res.send(wordBuffer);
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAiAnalysisController = new PdfAiAnalysisController();
