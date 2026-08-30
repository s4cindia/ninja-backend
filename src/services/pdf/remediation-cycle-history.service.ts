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
  action: 'apply_fixes' | 'reaudit' | 'ai_analysis' | 'auto_loop_summary';
  source: 'apply_all' | 'reaudit_pdf_upload' | 'reaudit_current_file' | 'analyze_job' | 'auto_loop';
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
