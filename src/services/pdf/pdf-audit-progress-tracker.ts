/**
 * PDF Audit Progress Tracker
 *
 * Builds the onProgress/onValidatorComplete/onAltTextImageProgress/
 * onContrastPageProgress callbacks pdfAuditService.runAuditFromBuffer
 * accepts, persisting page/validator progress into Job.input and
 * Job.progress so GET /jobs/:id (and the PdfJobProgressPanel UI that polls
 * it) can show live step-by-step progress.
 *
 * Extracted from accessibility.processor.ts (2026-10-18) so
 * pdf-batch-orchestrator.service.ts can share the exact same, already
 * incident-hardened implementation instead of writing its own -- same
 * reasoning as pdf-auto-tag-orchestrator.service.ts's extraction earlier
 * this session. Every callback here is wrapped in its own try/catch and can
 * never reject: a real production incident (2026-09-26) traced a full
 * container restart mid-audit to one of these, fired unawaited/fire-and-
 * forget from deep inside the parser/validators (pdf-comprehensive-parser
 * .service.ts, pdf-audit.service.ts), throwing an unhandled rejection with
 * no global handler anywhere in this codebase -- see
 * accessibility.processor.progress-callbacks.test.ts for the regression
 * coverage this preserves.
 *
 * Deliberately has NO dependency on a BullMQ Job object -- only
 * queueService.updateJobProgress (a Prisma Job.progress write, what GET
 * /jobs/:id actually returns) matters to any frontend consumer. The
 * single-file worker ALSO calls the real BullMQ job.updateProgress() for
 * its own dashboard/introspection value; pdf-batch-orchestrator.service.ts
 * has no equivalent BullMQ job reference this deep (its own PDF_BATCH_ITEM
 * job wraps a whole item's audit+remediation lifecycle, not just the audit
 * call) and has no need to invent one -- callers that want that extra
 * side-effect pass `onPercent`.
 */
import { Prisma } from '@prisma/client';
import { queueService } from '../queue.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface AuditProgressCallbacks {
  onProgress: (currentPage: number, totalPages: number) => Promise<void>;
  onValidatorComplete: (label: string, issuesFound: number, completed: number, total: number, startedAt: Date) => Promise<void>;
  onAltTextImageProgress: (completed: number, total: number) => Promise<void>;
  onContrastPageProgress: (completed: number, total: number) => Promise<void>;
  /** The most recent percentage this tracker computed -- for a caller that
   *  needs to re-report it independently (e.g. a stale-job heartbeat
   *  re-writing Job.updatedAt during a long validator phase with no new
   *  progress events of its own to react to). */
  getLastKnownPercent: () => number;
}

export interface AuditProgressTrackerOptions {
  jobId: string;
  /**
   * 0-100 staged percentage scheme for the page-by-page extraction phase.
   * Defaults match the single-file worker's own convention exactly --
   * PdfJobProgressPanel's "Page X of Y" display hard-codes these same
   * values, so a caller only needs to override them if it wants a visibly
   * different percentage range; using the defaults means that UI component
   * needs zero changes to work correctly against any caller's job.
   */
  extractionStartPct?: number;
  extractionPctRange?: number;
  /** 0-100 staged percentage scheme for the validator phase. */
  validatorStartPct?: number;
  validatorPctRange?: number;
  /**
   * Optional side-effect fired alongside every percentage this tracker
   * computes -- e.g. the single-file worker's BullMQ job.updateProgress()
   * for dashboard/introspection. Omit when the caller has no comparable
   * BullMQ job reference (e.g. the batch orchestrator).
   */
  onPercent?: (pct: number) => Promise<void> | void;
}

export function createAuditProgressCallbacks(options: AuditProgressTrackerOptions): AuditProgressCallbacks {
  const {
    jobId,
    extractionStartPct = 20,
    extractionPctRange = 68,
    validatorStartPct = 88,
    validatorPctRange = 7,
    onPercent,
  } = options;

  let totalPagesStored = false;
  // Tracked so onAltTextImageProgress can re-write the same value (see its
  // own doc comment below for why it never computes a new one).
  let lastKnownPct = extractionStartPct;

  const onProgress = async (currentPage: number, totalPages: number) => {
    try {
      if (!totalPagesStored && totalPages > 0) {
        const ej = await prisma.job.findUnique({ where: { id: jobId }, select: { input: true } });
        const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
          ? ej.input as Record<string, unknown> : {};
        await prisma.job.update({
          where: { id: jobId },
          data: { input: { ...ei, totalPages } as Prisma.InputJsonObject },
        });
        // Only mark stored once the write actually succeeds -- setting this
        // before the await meant a transient failure here left it
        // permanently true, silently skipping this persistence block for
        // the rest of the audit even after the transient condition cleared
        // (a real CodeRabbit + Codex finding).
        totalPagesStored = true;
        logger.info(`[AuditProgressTracker] Job ${jobId}: ${totalPages} pages to audit`);
      }
      if (totalPages > 0) {
        const pct = extractionStartPct + Math.round((currentPage / totalPages) * extractionPctRange);
        lastKnownPct = pct;
        await onPercent?.(pct);
        await queueService.updateJobProgress(jobId, pct);
      }
    } catch (err) {
      logger.warn(`[AuditProgressTracker] onProgress callback failed for job ${jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const validatorProgress: Array<{ label: string; issuesFound: number; startedAt: string; completedAt: string }> = [];
  const onValidatorComplete = async (label: string, issuesFound: number, completed: number, total: number, startedAt: Date) => {
    try {
      validatorProgress.push({ label, issuesFound, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() });
      logger.info(`[AuditProgressTracker] Validator "${label}" done for job ${jobId}: ${issuesFound} issues (${completed}/${total})`);
      const pct = validatorStartPct + Math.round((completed / total) * validatorPctRange);
      lastKnownPct = pct;
      await onPercent?.(pct);
      await queueService.updateJobProgress(jobId, pct);
      const ej = await prisma.job.findUnique({ where: { id: jobId }, select: { input: true } });
      const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
        ? ej.input as Record<string, unknown> : {};
      await prisma.job.update({
        where: { id: jobId },
        data: { input: { ...ei, validatorProgress: [...validatorProgress] } as Prisma.InputJsonObject },
      });
    } catch (err) {
      logger.warn(`[AuditProgressTracker] onValidatorComplete callback failed for job ${jobId}, validator "${label}" (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Alt Text sub-progress: touches Job.updatedAt every ~30s while
  // PDFAltTextValidator works through a large image set, independent of
  // onValidatorComplete above (which only fires once, after ALL images are
  // done). Real incident (2026-09-25): a 3843-image document ran this step
  // for 20+ minutes with no intervening update, which the stale-job
  // watchdog (src/workers/index.ts) then wrongly killed as "orphaned" -- it
  // was still genuinely working, just not reporting in. Deliberately
  // re-writes lastKnownPct rather than computing a new value: guessing at
  // Alt Text's share of the validator range here risks the progress bar
  // visibly jumping backward relative to what onValidatorComplete will
  // report once this validator actually finishes.
  const onAltTextImageProgress = async (completed: number, total: number) => {
    try {
      logger.info(`[AuditProgressTracker] Alt Text progress for job ${jobId}: ${completed}/${total} images`);
      await onPercent?.(lastKnownPct);
      await queueService.updateJobProgress(jobId, lastKnownPct);
      const ej = await prisma.job.findUnique({ where: { id: jobId }, select: { input: true } });
      const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
        ? ej.input as Record<string, unknown> : {};
      await prisma.job.update({
        where: { id: jobId },
        data: { input: { ...ei, altTextImageProgress: { completed, total } } as Prisma.InputJsonObject },
      });
    } catch (err) {
      logger.warn(`[AuditProgressTracker] onAltTextImageProgress callback failed for job ${jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Contrast sub-progress: touches Job.updatedAt every ~30s while
  // PdfContrastValidator renders+samples a large page set, independent of
  // onValidatorComplete above (which only fires once, after ALL pages are
  // done). Real incident (2026-10-19): FMHE_PDF.pdf's 2040-page Color
  // Contrast pass ran for 17+ minutes with no intervening update, which the
  // audit-wide staleness timeout (pdf-audit.service.ts's withAuditTimeout)
  // then correctly-but-unhelpfully killed as a suspected hang -- it was
  // still genuinely working, just not reporting in (same class of problem
  // onAltTextImageProgress above was built to fix for Alt Text). Mirrors
  // that callback's own reasoning exactly, including re-writing
  // lastKnownPct rather than computing a new value.
  const onContrastPageProgress = async (completed: number, total: number) => {
    try {
      logger.info(`[AuditProgressTracker] Contrast progress for job ${jobId}: ${completed}/${total} pages`);
      await onPercent?.(lastKnownPct);
      await queueService.updateJobProgress(jobId, lastKnownPct);
      const ej = await prisma.job.findUnique({ where: { id: jobId }, select: { input: true } });
      const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
        ? ej.input as Record<string, unknown> : {};
      await prisma.job.update({
        where: { id: jobId },
        data: { input: { ...ei, contrastPageProgress: { completed, total } } as Prisma.InputJsonObject },
      });
    } catch (err) {
      logger.warn(`[AuditProgressTracker] onContrastPageProgress callback failed for job ${jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { onProgress, onValidatorComplete, onAltTextImageProgress, onContrastPageProgress, getLastKnownPercent: () => lastKnownPct };
}
