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
import { pdfContrastWriterService } from '../services/pdf/pdf-contrast-writer.service';
import { pdfReauditService } from '../services/pdf/pdf-reaudit.service';
import { TABLE_LIKELY_FORMULA_CODE } from '../services/pdf/validators/pdf-table.validator';
import type { AuditIssue } from '../services/audit/base-audit.service';
import { aiConfig } from '../config/ai.config';
import { remediationCycleLockService } from '../services/pdf/remediation-cycle-lock.service';
import { remediationCycleHistoryService } from '../services/pdf/remediation-cycle-history.service';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const triggerSchema = z.object({
  overrides: z
    .object({
      tableFixMode: z.enum(['apply-to-pdf', 'guidance-only', 'summaries-to-pdf-headers-as-guidance']).optional(),
      altTextMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
      listMode: z.enum(['auto-resolve-decorative', 'guidance-only']).optional(),
      languageMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
      colorContrastMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
      linkTextMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
      formFieldMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
      bookmarkMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
      confidenceThreshold: z.number().min(0.5).max(0.95).optional(),
      autoApplyHighConfidence: z.boolean().optional(),
    })
    .optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  // Lets an operator override the AI-drafted value before approving (e.g.
  // edit a suggested link description/form-field tooltip/bookmark title) --
  // applyApprovedSuggestions applies whatever is in `value` at approval
  // time, so this needs no separate "apply" wiring.
  value: z.string().trim().min(1).max(1000).optional(),
});

const acknowledgeGuidanceSchema = z.object({
  note: z.string().trim().min(1),
});

const logManualRemediationTimeSchema = z.object({
  minutes: z.number().positive(),
  note: z.string().trim().optional(),
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

      // AI analysis holds the remediation-cycle lock for its full run
      // (can be minutes for documents with many issues) so it can never
      // interleave with an in-flight apply-fixes/re-audit cycle on the
      // same job — that interleaving is what produced non-monotonic
      // "Applied" counts and stale summaries in practice.
      const lock = await remediationCycleLockService.acquireLock(job.id, req.user.id, 'analyze_job');
      if (!lock.acquired) {
        throw AppError.conflict(
          'Another remediation cycle is already in progress for this job. Wait for it to finish before re-running AI analysis.',
          'REMEDIATION_CYCLE_IN_PROGRESS',
          { lockedAt: lock.lockedAt, lockedBy: lock.lockedBy, source: lock.source }
        );
      }
      const cycleNumber = lock.cycleNumber!;
      const cycleStartedAt = new Date();
      const heartbeat = remediationCycleLockService.startHeartbeat(job.id, cycleNumber);

      // Fire-and-forget — client polls GET endpoint for results
      aiAnalysisService
        .analyzeJob(job.id, tenantId, overrides)
        .then(async ({ analyzed, skipped }) => {
          logger.info(`[AI Analysis] Job ${job.id} complete: ${analyzed} analyzed, ${skipped} skipped`);
          await remediationCycleHistoryService.logEvent({
            jobId: job.id,
            cycleNumber,
            action: 'ai_analysis',
            source: 'analyze_job',
            status: 'completed',
            appliedCount: analyzed,
            failedCount: skipped,
            triggeredBy: req.user!.id,
            startedAt: cycleStartedAt,
          });
        })
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[AI Analysis] Job ${job.id} failed: ${message}`);
          await remediationCycleHistoryService.logEvent({
            jobId: job.id,
            cycleNumber,
            action: 'ai_analysis',
            source: 'analyze_job',
            status: 'failed',
            errorMessage: message,
            triggeredBy: req.user!.id,
            startedAt: cycleStartedAt,
          });
        })
        .finally(() => {
          remediationCycleLockService.stopHeartbeat(heartbeat);
          void remediationCycleLockService.releaseLock(job.id, cycleNumber);
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
      // 'pending'    → AI hasn't started yet (no stats written, lock not held for this job)
      // 'processing' → currently running (remediation-cycle lock held with source 'analyze_job')
      // 'complete'   → aiAnalysisStats written to job.output (source of truth)
      const lockStatus = await remediationCycleLockService.getLockStatus(jobId);
      const status =
        lockStatus.inProgress && lockStatus.source === 'analyze_job'
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
          guidanceAcknowledgment: (output.guidanceAcknowledgment as Record<string, unknown> | undefined) ?? null,
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
        data: {
          status: parsed.data.status,
          approvedBy: parsed.data.status === 'approved' ? 'operator' : existing.approvedBy,
          ...(parsed.data.value !== undefined && { value: parsed.data.value }),
          updatedAt: new Date(),
        },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/ai-analysis/guidance-acknowledgment
   * Records the operator's acknowledgment that guidance-only suggestions are
   * being left for manual/out-of-tool resolution, with a required note —
   * part of the guided-remediation checklist's step 4 gate.
   */
  async acknowledgeGuidance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const jobId = job.id;

      const parsed = acknowledgeGuidanceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw AppError.badRequest('Invalid request body: ' + parsed.error.message);
      }

      // Computed server-side rather than trusted from the client, so the
      // recorded count always reflects what's actually still pending.
      const remainingCount = await prisma.aiAnalysis.count({
        where: { jobId, applyMode: 'guidance-only', status: 'pending' },
      });

      const guidanceAcknowledgment = {
        note: parsed.data.note,
        remainingCount,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: req.user.id,
      };

      // Re-fetch immediately before writing rather than trusting req.job (a
      // snapshot from when authorizeJob ran) — a concurrent write elsewhere
      // (e.g. analyzeJob persisting aiAnalysisStats) could otherwise be
      // silently erased by this one replacing the whole output JSON blob
      // with a stale copy. Same pattern as the stats-save in
      // ai-analysis.service.ts's analyzeJob.
      const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
      const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;

      await prisma.job.update({
        where: { id: jobId },
        data: { output: { ...latestOutput, guidanceAcknowledgment } as Prisma.InputJsonObject },
      });

      res.json({ success: true, data: guidanceAcknowledgment });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/manual-remediation-time
   * Logs self-reported time spent on manual out-of-app remediation (e.g.
   * Acrobat Pro) for guidance-only items Ninja can't auto-fix — invisible to
   * the automatic RemediationSession timer, which only tracks time active on
   * Ninja's own pages. Accumulates across multiple calls (multiple sessions
   * are expected), independent of the guidance-acknowledgment flow so it
   * still works when an operator manually resolves every guidance item
   * rather than acknowledging-and-skipping the rest.
   */
  async logManualRemediationTime(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const jobId = job.id;

      const parsed = logManualRemediationTimeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw AppError.badRequest('Invalid request body: ' + parsed.error.message);
      }
      const { minutes, note } = parsed.data;

      const entry = {
        minutes,
        note,
        loggedAt: new Date().toISOString(),
        loggedBy: req.user.id,
      };

      // Unlike the single-value output flags elsewhere in this controller
      // (guidance-acknowledgment, acrGenerated, pacReportGenerated), this
      // field is an appended log of discrete entries — a lost update here
      // doesn't just cause a harmless redundant recompute, it silently
      // deletes a real logged time entry with no way to recover it. That's
      // a materially worse failure mode for exactly the kind of thing this
      // feature exists to capture accurately, so a plain re-fetch-before-write
      // (which only narrows the race) isn't good enough here — this uses a
      // Serializable transaction with retry-on-conflict so a concurrent
      // append (double-submit, two tabs) can never overwrite the other.
      let totalMs = 0;
      let log: unknown[] = [];
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          ({ totalMs, log } = await prisma.$transaction(
            async (tx) => {
              const latestJob = await tx.job.findUnique({ where: { id: jobId } });
              const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
              const existingLog = Array.isArray(latestOutput.manualRemediationLog)
                ? (latestOutput.manualRemediationLog as Array<{ minutes: number }>)
                : [];
              const nextLog = [...existingLog, entry];
              // Derived from the log on every write rather than tracked
              // separately, so the total can never drift out of sync with
              // its entries.
              const nextTotalMs = Math.round(nextLog.reduce((sum, e) => sum + e.minutes, 0) * 60000);

              await tx.job.update({
                where: { id: jobId },
                data: {
                  output: {
                    ...latestOutput,
                    manualRemediationLog: nextLog,
                    manualRemediationMs: nextTotalMs,
                  } as Prisma.InputJsonObject,
                },
              });

              return { totalMs: nextTotalMs, log: nextLog };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ));
          break;
        } catch (err) {
          const isSerializationConflict =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
          if (!isSerializationConflict || attempt === MAX_ATTEMPTS) throw err;
        }
      }

      // Atomic increment — race-free at the DB level, no read-modify-write
      // needed for this single numeric column (unlike the JSON output above).
      // Skipped entirely for jobs with no linked comparison trial.
      const trial = await prisma.comparisonTrial.findFirst({ where: { ninjaJobId: jobId }, select: { id: true } });
      if (trial) {
        await prisma.comparisonTrial.update({
          where: { id: trial.id },
          data: { ninjaManualTimeMs: { increment: Math.round(minutes * 60000) } },
        });
      }

      res.json({ success: true, data: { totalMinutes: totalMs / 60000, log } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/ai-analysis/:issueId/apply
   * Apply a single approved AI suggestion to the PDF.
   */
  async applySuggestion(req: Request, res: Response, next: NextFunction): Promise<void> {
    let lockAcquired = false;
    let cycleNumberForFinally: number | undefined;
    const jobIdForFinally = req.job?.id;
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const { issueId } = req.params;
      const jobId = job.id;

      // Single-issue apply acquires the lock too (briefly -- released at the
      // end of this request, no heartbeat needed since it's fast), rather
      // than just checking status: a check-then-write here has the same
      // TOCTOU gap the lock exists to close -- two single applies, or a
      // single apply racing a bulk cycle's acquisition, could both pass a
      // read-only check and then modify/save the same PDF concurrently.
      // Acquiring still lets operators fire many single applies back-to-back
      // (each acquires and releases in turn) without blocking on a
      // multi-minute AI-analysis hold, since only one is ever actually
      // in flight at a time.
      const lock = await remediationCycleLockService.acquireLock(jobId, req.user.id, 'apply_single');
      if (!lock.acquired) {
        throw AppError.conflict(
          'A remediation cycle is currently in progress for this job. Wait for it to finish before applying more fixes.',
          'REMEDIATION_CYCLE_IN_PROGRESS',
          { lockedAt: lock.lockedAt, lockedBy: lock.lockedBy, source: lock.source }
        );
      }
      lockAcquired = true;
      cycleNumberForFinally = lock.cycleNumber!;

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
      } else if (suggestionType === 'heading-multiple-h1-fix') {
        const result = pdfStructureWriterService.fixMultipleH1(doc, originalIssue);
        modification = { success: result.success, description: result.after, error: result.error };
      } else if (suggestionType === 'pdfua-identifier') {
        modification = await pdfModifierService.writePdfUaIdentifier(doc);
      } else if (suggestionType === 'color-contrast-fix') {
        const result = await pdfContrastWriterService.fixColorContrast(doc, originalIssue);
        modification = { success: result.success, description: result.after, error: result.error };
      } else if (suggestionType === 'alt-text-decorative') {
        // Hardcoded '' rather than the stored value — '' is falsy and would
        // otherwise trip the "no value to apply" guard below for no reason.
        modification = await pdfModifierService.setAltText(doc, elementId, '');
      } else {
        // Value-based operations
        if (!value) throw AppError.badRequest('This suggestion has no value to apply');

        if (suggestionType === 'alt-text' || suggestionType === 'alt-text-improvement') {
          modification = await pdfModifierService.setAltText(doc, elementId, value);
        } else if (suggestionType === 'table-summary') {
          modification = await pdfModifierService.setTableSummary(doc, elementId, value);
        } else if (suggestionType === 'formula-actualtext') {
          // A table region redirected to a formula suggestion is tagged
          // /Table, not /Formula — see TABLE_LIKELY_FORMULA_CODE's doc comment.
          const elementTypes = originalIssue.code === TABLE_LIKELY_FORMULA_CODE
            ? new Set(['Table', 'table'])
            : undefined;
          modification = await pdfModifierService.setActualText(doc, elementId, value, elementTypes);
        } else if (suggestionType === 'language') {
          modification = await pdfModifierService.addLanguage(doc, value);
        } else if (suggestionType === 'link-text') {
          modification = await pdfModifierService.setLinkAltText(doc, originalIssue, value);
        } else if (suggestionType === 'form-field-label') {
          modification = await pdfModifierService.setFormFieldTooltip(doc, originalIssue, value);
        } else if (suggestionType === 'bookmark-title') {
          modification = await pdfModifierService.renameBookmark(doc, originalIssue, value);
        } else {
          throw AppError.badRequest(`suggestionType "${suggestionType}" cannot be applied to PDF`);
        }
      }

      if (!modification.success) {
        logger.warn(`[ApplySuggestion] modification failed: ${modification.error}`);
        throw AppError.unprocessable(modification.error ?? 'Failed to apply modification');
      }

      // Save modified PDF and record path so download endpoint can find it
      const modifiedBuffer = await pdfModifierService.savePDF(doc);
      const savedPath = await fileStorageService.saveRemediatedFile(jobId, fileName, modifiedBuffer);
      // Re-fetch immediately before writing rather than reusing the
      // top-of-request job.output snapshot, matching the idiom already used
      // by acknowledgeGuidance in this file — narrows the window for this
      // write to clobber anything else that touched job.output meanwhile.
      const latestJobForWrite = await prisma.job.findUnique({ where: { id: jobId } });
      const currentOutput = (latestJobForWrite?.output ?? {}) as Record<string, unknown>;
      await prisma.job.update({
        where: { id: jobId },
        data: { output: { ...currentOutput, remediatedFileUrl: savedPath } as Prisma.InputJsonObject },
      });

      // Update status to applied
      const updatedAnalysis = await prisma.aiAnalysis.update({
        where: { jobId_issueId: { jobId, issueId } },
        data: { status: 'applied', updatedAt: new Date() },
      });

      logger.info(`[AI Analysis] Applied ${suggestionType} for issue ${issueId} in job ${jobId}`);

      res.json({
        success: true,
        data: { ...updatedAnalysis, modification },
      });
    } catch (error) {
      next(error);
    } finally {
      if (lockAcquired && jobIdForFinally && cycleNumberForFinally !== undefined) {
        await remediationCycleLockService.releaseLock(jobIdForFinally, cycleNumberForFinally);
      }
    }
  }

  /**
   * POST /pdf/:jobId/ai-analysis/apply-all
   * Apply all approved apply-to-pdf suggestions in a single PDF pass.
   */
  async applyAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    // lockAcquired guards the finally below: without it, a request that gets
    // rejected with 409 (never actually acquired the lock) would release the
    // OTHER, legitimate cycle's lock out from under it. cycleNumberForFinally
    // and heartbeatForFinally are set once the lock is acquired so the outer
    // finally can stop/release on every early-return/thrown-error path; the
    // success path below hands both off to the fire-and-forget re-audit chain.
    let lockAcquired = false;
    let lockHandedOff = false;
    let cycleNumberForFinally: number | undefined;
    let heartbeatForFinally: NodeJS.Timeout | undefined;
    const jobIdForFinally = req.job?.id;
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const job = req.job!;
      const jobId = job.id;

      // Acquire the remediation-cycle lock before doing anything else: this
      // is the entry point that produced the original bug (a false-timeout
      // "Network Error" retry starting a second apply+re-audit cycle while
      // the first was still finishing, with whichever write landed last
      // silently winning). Held through the fire-and-forget re-audit below,
      // not just this synchronous portion.
      const lock = await remediationCycleLockService.acquireLock(jobId, req.user.id, 'apply_all');
      if (!lock.acquired) {
        throw AppError.conflict(
          'Another remediation cycle is already in progress for this job. Wait for it to finish before applying fixes again.',
          'REMEDIATION_CYCLE_IN_PROGRESS',
          { lockedAt: lock.lockedAt, lockedBy: lock.lockedBy, source: lock.source }
        );
      }
      lockAcquired = true;
      const cycleNumber = lock.cycleNumber!;
      cycleNumberForFinally = cycleNumber;
      const cycleStartedAt = new Date();
      // Started immediately after acquisition, not right before the
      // fire-and-forget re-audit dispatch below -- the synchronous
      // per-issue apply loop that follows can itself take minutes for a
      // large batch, and without a heartbeat running for that whole span a
      // slow loop could cross the staleness threshold and let another
      // request reclaim the lock while this one is still actively modifying
      // the PDF.
      const heartbeat = remediationCycleLockService.startHeartbeat(jobId, cycleNumber);
      heartbeatForFinally = heartbeat;

      const includePending = req.query.includePending === 'true';
      const { applied, failed, errors, modifiedBuffer, fileName } =
        await aiAnalysisService.applyApprovedSuggestions(jobId, cycleNumber, req.user.id, 'apply_all', { includePending });

      if (applied === 0 && failed === 0) {
        res.json({
          success: true,
          data: { applied: 0, failed: 0, message: 'No approved or pending suggestions to apply' },
        });
        return;
      }

      // Save modified PDF once regardless of partial failures
      if (applied > 0 && modifiedBuffer && fileName) {
        // Hand the lock off to the fire-and-forget chain below — it (not
        // this synchronous request) now owns stopping the heartbeat and
        // releasing the lock (both already started/acquired above).
        lockHandedOff = true;

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
                  // The fresh audit (score, matterhornSummary, issues) must replace
                  // the stale pre-fix one — otherwise the results page keeps showing
                  // the original numbers forever, no matter how many fixes land.
                  ...(comparison.success && comparison.reauditReport ? { auditReport: comparison.reauditReport } : {}),
                  postRemediationStatus: 'complete',
                  postRemediationAudit: {
                    runAt: new Date().toISOString(),
                    resolved: resolvedCount,
                    remaining: remainingCount,
                    regressions: regressionCount,
                    resolutionRate,
                  },
                } as unknown as Prisma.InputJsonObject,
              },
            });
            logger.info(`[ApplyAll] Post-remediation re-audit complete for job ${jobId}: ${resolvedCount} resolved, ${regressionCount} regressions`);
            await remediationCycleHistoryService.logEvent({
              jobId,
              cycleNumber,
              action: 'reaudit',
              source: 'apply_all',
              status: comparison.success ? 'completed' : 'failed',
              resolvedCount,
              remainingCount,
              regressionCount,
              resolutionRate,
              errorMessage: comparison.success ? undefined : comparison.error,
              triggeredBy: req.user!.id,
              startedAt: cycleStartedAt,
            });
          })
          .catch(async (err) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[ApplyAll] Post-remediation re-audit failed (non-fatal): ${message}`);
            try {
              const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
              const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
              await prisma.job.update({
                where: { id: jobId },
                data: { output: { ...latestOutput, postRemediationStatus: 'failed' } as Prisma.InputJsonObject },
              });
            } catch { /* non-fatal — status update failure should not surface */ }
            await remediationCycleHistoryService.logEvent({
              jobId,
              cycleNumber,
              action: 'reaudit',
              source: 'apply_all',
              status: 'failed',
              errorMessage: message,
              triggeredBy: req.user!.id,
              startedAt: cycleStartedAt,
            });
          })
          .finally(() => {
            remediationCycleLockService.stopHeartbeat(heartbeat);
            void remediationCycleLockService.releaseLock(jobId, cycleNumber);
          });
      }
      // else: applied === 0 but failed > 0 (every suggestion failed to
      // apply) — aiAnalysisService.applyApprovedSuggestions already logged
      // the 'apply_fixes'/'failed' history event itself; no PDF was saved
      // and no re-audit was started, so the outer finally below releases
      // the lock immediately.

      logger.info(`[AI Analysis] apply-all for job ${jobId}: ${applied} applied, ${failed} failed`);

      res.json({
        success: true,
        data: { applied, failed, errors: errors.length > 0 ? errors : undefined },
      });
    } catch (error) {
      next(error);
    } finally {
      if (lockAcquired && !lockHandedOff && jobIdForFinally) {
        if (heartbeatForFinally) remediationCycleLockService.stopHeartbeat(heartbeatForFinally);
        await remediationCycleLockService.releaseLock(jobIdForFinally, cycleNumberForFinally!);
      }
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
                taggerSource: 'adobe',
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

      // Lets the guided-remediation checklist know whether this job is part of
      // the pdfxt comparison study (and, if so, which trial to validate) —
      // jobs created via the plain upload flow have no linked trial at all.
      const comparisonTrial = await prisma.comparisonTrial.findFirst({
        where: { ninjaJobId: job.id },
        select: { id: true },
      });

      // Lets the checklist gate its action buttons on server state instead
      // of client-side in-flight tracking -- a client-side flag reset by a
      // spurious network error (e.g. a CloudFront timeout on a long-running
      // apply-all) can no longer make a retry look safe when it isn't.
      const lockStatus = await remediationCycleLockService.getLockStatus(job.id);

      res.json({
        success: true,
        data: {
          remediationCycleInProgress: lockStatus.inProgress,
          remediationCycleLockedAt: lockStatus.lockedAt ?? null,
          remediationCycleLockedBy: lockStatus.lockedBy ?? null,
          remediationCycleSource: lockStatus.source ?? null,
          comparisonTrialId: comparisonTrial?.id ?? null,
          manualRemediationMs: (output.manualRemediationMs as number | undefined) ?? 0,
          // Timestamp of the most recent manual-remediation-time entry, if any —
          // lets the checklist tell "manual work happened after the last
          // re-audit" apart from "no manual work has been logged at all".
          // Takes the max loggedAt across all entries rather than the last
          // array position: loggedAt is generated before the serializable
          // transaction that appends it, so under concurrent submissions a
          // retried (earlier-timestamped) request can still land after a
          // faster (later-timestamped) one in array order.
          manualRemediationLastLoggedAt: Array.isArray(output.manualRemediationLog) && output.manualRemediationLog.length > 0
            ? (output.manualRemediationLog as Array<{ loggedAt: string }>)
                .reduce((latest, e) => (e.loggedAt > latest ? e.loggedAt : latest), '')
            : null,
          status: (output.autoTagStatus as string | undefined) ?? 'unknown',
          error: output.autoTagError as string | undefined,
          skipReason: output.autoTagSkipReason as string | undefined,
          taggerSource: output.taggerSource as string | undefined,
          hasTaggingReport: (output.hasTaggingReport as boolean | undefined) ?? false,
          hasWordExport: (output.hasWordExport as boolean | undefined) ?? false,
          elementCounts: output.autoTagElementCounts ?? null,
          structureTreeCompleteness: output.structureTreeCompleteness ?? null,
          retagOutcome: output.retagOutcome ?? null,
          adobeFlags: (autoTagProgress.adobeFlags as unknown[] | undefined) ?? [],
          postRemediationStatus: output.postRemediationStatus as string | undefined,
          postRemediationAudit: output.postRemediationAudit as Record<string, unknown> | undefined,
          postRemediationProgress: output.postRemediationProgress as Record<string, unknown> | undefined,
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
