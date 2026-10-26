/**
 * Reliability / infra health report (Operational Reports Group 4 -- see
 * OPERATIONAL_REPORTS_DESIGN.md). Two halves:
 *
 * 1. Interruption count -- deploy/crash-caused auto-mode stops, now logged
 *    into RemediationCycleEvent (action 'force_stopped'/'orphan_reconciled')
 *    by auto-remediation-loop.service.ts instead of only logger.warn()
 *    (CloudWatch-only, not queryable) as before.
 *
 * 2. Failure-reason breakdown -- deliberately classifies Job.error's
 *    existing freeform text at READ time instead of adding a new
 *    Job.errorCode column populated at write time. 28+ call sites across
 *    this codebase can mark a Job FAILED with no single centralized
 *    helper, so a write-time column would mean touching many call sites for
 *    a nullable-field, worth-it-later feature -- read-time classification
 *    gets the same report value with zero schema change and zero risk to
 *    those call sites. If classifyErrorMessage's UNKNOWN bucket turns out
 *    to dominate in practice, that is the signal to add more patterns here
 *    (or revisit the write-time-column design), not something to
 *    pre-optimize now.
 */

import prisma from '../../lib/prisma';

export interface ReliabilityReportParams {
  tenantId: string;
  from: Date;
  to: Date;
}

export type ErrorCategory = 'SIZE_LIMIT_EXCEEDED' | 'TIMEOUT' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'UNKNOWN';

export interface ReliabilityReport {
  period: { from: string; to: string };
  interruptionCount: number;
  interruptionsByAction: Record<string, number>;
  failureCount: number;
  failuresByCategory: Record<ErrorCategory, number>;
}

/** Ordered, first-match-wins. Patterns are deliberately narrow (based on
 * real observed error text, e.g. "PDF file exceeds maximum size of 500MB")
 * rather than broad guesses -- see the file's own doc comment for why this
 * stays small rather than trying to be exhaustive up front. */
const CLASSIFIERS: Array<{ category: ErrorCategory; pattern: RegExp }> = [
  { category: 'SIZE_LIMIT_EXCEEDED', pattern: /exceeds maximum size|too large|file size/i },
  { category: 'TIMEOUT', pattern: /timed? ?out/i },
  { category: 'PARSE_ERROR', pattern: /parse|corrupt|invalid pdf|malformed/i },
  { category: 'VALIDATION_ERROR', pattern: /validation/i },
];

export function classifyErrorMessage(error: string | null): ErrorCategory {
  if (!error) return 'UNKNOWN';
  for (const { category, pattern } of CLASSIFIERS) {
    if (pattern.test(error)) return category;
  }
  return 'UNKNOWN';
}

const INTERRUPTION_ACTIONS = ['force_stopped', 'orphan_reconciled'] as const;

class ReliabilityReportService {
  async getReport(params: ReliabilityReportParams): Promise<ReliabilityReport> {
    const { tenantId, from, to } = params;

    const [interruptionEvents, failedJobs] = await Promise.all([
      prisma.remediationCycleEvent.findMany({
        where: {
          job: { tenantId },
          startedAt: { gte: from, lte: to },
          action: { in: [...INTERRUPTION_ACTIONS] },
        },
        select: { action: true },
      }),
      prisma.job.findMany({
        where: { tenantId, status: 'FAILED', createdAt: { gte: from, lte: to } },
        select: { error: true },
      }),
    ]);

    const interruptionsByAction: Record<string, number> = {};
    for (const event of interruptionEvents) {
      interruptionsByAction[event.action] = (interruptionsByAction[event.action] ?? 0) + 1;
    }

    const failuresByCategory: Record<ErrorCategory, number> = {
      SIZE_LIMIT_EXCEEDED: 0,
      TIMEOUT: 0,
      PARSE_ERROR: 0,
      VALIDATION_ERROR: 0,
      UNKNOWN: 0,
    };
    for (const job of failedJobs) {
      failuresByCategory[classifyErrorMessage(job.error)] += 1;
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      interruptionCount: interruptionEvents.length,
      interruptionsByAction,
      failureCount: failedJobs.length,
      failuresByCategory,
    };
  }
}

export const reliabilityReportService = new ReliabilityReportService();
