/**
 * Remediation Cycle History Service
 *
 * Append-only log of every completed (or failed) apply-fixes, re-audit, or
 * AI-re-analysis action, grouped by cycleNumber (see
 * remediation-cycle-lock.service.ts) so the guided-remediation checklist can
 * render "Run 1 / Run 2 / ..." instead of a single overwritten summary that
 * can't be reconciled after repeated apply/re-audit/re-analyze loops.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import type { RemediationCycleEvent } from '@prisma/client';

export interface LogCycleEventInput {
  jobId: string;
  cycleNumber: number;
  action: 'apply_fixes' | 'reaudit' | 'ai_analysis' | 'auto_loop_summary' | 'force_stopped' | 'orphan_reconciled';
  source: 'apply_all' | 'reaudit_pdf_upload' | 'reaudit_current_file' | 'analyze_job' | 'auto_loop' | 'shutdown' | 'watchdog';
  status: 'completed' | 'failed';
  appliedCount?: number;
  failedCount?: number;
  resolvedCount?: number;
  remainingCount?: number;
  regressionCount?: number;
  resolutionRate?: number;
  errorMessage?: string;
  triggeredBy?: string;
  startedAt: Date;
  /** This round's AI spend -- see the Prisma field's own doc comment for
   * why it's only ever populated on the 'ai_analysis' action. */
  costUsd?: number;
}

class RemediationCycleHistoryService {
  /** Non-fatal by design -- a logging failure must never fail the parent
   * request that already did the real work (matches the stale-suggestion-
   * pruning precedent in ai-analysis.service.ts's analyzeJob). */
  async logEvent(input: LogCycleEventInput): Promise<void> {
    try {
      await prisma.remediationCycleEvent.create({ data: { ...input, completedAt: new Date() } });
    } catch (err) {
      logger.warn(
        `[RemediationCycleHistory] Failed to log ${input.action} event for job ${input.jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async listForJob(jobId: string): Promise<RemediationCycleEvent[]> {
    return prisma.remediationCycleEvent.findMany({
      where: { jobId },
      orderBy: { startedAt: 'asc' },
    });
  }
}

export const remediationCycleHistoryService = new RemediationCycleHistoryService();

/**
 * Derives a job's real cumulative auto-fix counts from its remediation
 * history -- the single source of truth both pdf-batch-orchestrator.service
 * .ts's one-time PdfBatchItem write and pdf-batch.controller.ts's live
 * GET /pdf-batches/:batchId read now share, so they can never drift apart
 * the way the original issuesAutoFixed bug (PR #708) did.
 *
 * resolvedCount is inherently per-round (how many issues THAT round's
 * reaudit resolved), never cumulative, so only the gap between the
 * original audit's issue count and the LATEST reaudit's own remainingCount
 * is actually cumulative by construction -- see PR #708's own doc comment
 * for the incident this fixed. Safe to call at any point mid-round: the
 * latest *completed* reaudit is always a consistent, final snapshot of
 * where things stood as of that reaudit, never a partial/torn read.
 *
 * Returns null when no reaudit has ever completed for this job -- nothing
 * to report yet, caller decides the fallback (e.g. keep showing whatever
 * it already has).
 */
export async function computeRemediationCounts(
  jobId: string,
  issuesFound: number | null
): Promise<{ issuesAutoFixed: number; issuesGuidanceOnly: number } | null> {
  const events = await remediationCycleHistoryService.listForJob(jobId);
  const lastReaudit = [...events].reverse().find(
    (e) => e.action === 'reaudit' && e.status === 'completed' && e.resolvedCount != null
  );
  if (!lastReaudit) return null;

  const issuesGuidanceOnly = lastReaudit.remainingCount ?? 0;
  const issuesAutoFixed = Math.max(0, (issuesFound ?? 0) - issuesGuidanceOnly);
  return { issuesAutoFixed, issuesGuidanceOnly };
}
