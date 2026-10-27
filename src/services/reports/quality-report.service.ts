/**
 * Fix quality / effectiveness report (Operational Reports Group 3 -- see
 * OPERATIONAL_REPORTS_DESIGN.md). Three pieces:
 *
 * 1. Yield by suggestion type -- aggregates RemediationCycleEvent's new
 *    suggestionTypeBreakdown field (ai-analysis.service.ts's
 *    applyApprovedSuggestions) across the period. The one piece of this
 *    group that genuinely needed new instrumentation.
 * 2. Score-delta trend for one job -- already fully available via the
 *    'reaudit' action's resolutionRate (no new field needed).
 * 3. Stuck-issue backlog -- latest audit issues for jobs whose auto-mode
 *    run has stopped (exhausted its rounds/cost cap or converged),
 *    grouped by issue code. UNIONs both auto-mode driver tables for the
 *    same dual-path reality as cost-report.service.ts. Capped (not a full
 *    scan) since Job.output is not index-backed -- see the design doc's own
 *    performance note.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { extractJobFileName } from './job-filename.util';

export interface QualityReportParams {
  tenantId: string;
  from: Date;
  to: Date;
}

export interface SuggestionTypeYield {
  suggestionType: string;
  applied: number;
  failed: number;
  yieldRate: number; // applied / (applied + failed), 0 when both are 0
}

export interface QualityReport {
  period: { from: string; to: string };
  yieldByType: SuggestionTypeYield[];
}

export interface ScoreTrendPoint {
  cycleNumber: number;
  resolvedCount: number | null;
  remainingCount: number | null;
  resolutionRate: number | null;
  completedAt: string;
}

export interface StuckIssueSampleJob {
  jobId: string;
  fileName: string | null;
}

export interface StuckIssueEntry {
  code: string;
  count: number;
  sampleJobs: StuckIssueSampleJob[];
}

const STUCK_ISSUES_JOB_LIMIT = 50;
const STUCK_ISSUES_SAMPLE_LIMIT = 5;

class QualityReportService {
  async getReport(params: QualityReportParams): Promise<QualityReport> {
    const { tenantId, from, to } = params;

    const events = await prisma.remediationCycleEvent.findMany({
      where: {
        job: { tenantId },
        startedAt: { gte: from, lte: to },
        action: 'apply_fixes',
        suggestionTypeBreakdown: { not: Prisma.DbNull },
      },
      select: { suggestionTypeBreakdown: true },
    });

    const totals = new Map<string, { applied: number; failed: number }>();
    for (const event of events) {
      const breakdown = event.suggestionTypeBreakdown as Record<string, { applied: number; failed: number }> | null;
      if (!breakdown) continue;
      for (const [suggestionType, counts] of Object.entries(breakdown)) {
        const entry = totals.get(suggestionType) ?? { applied: 0, failed: 0 };
        entry.applied += counts.applied ?? 0;
        entry.failed += counts.failed ?? 0;
        totals.set(suggestionType, entry);
      }
    }

    const yieldByType: SuggestionTypeYield[] = Array.from(totals.entries())
      .map(([suggestionType, { applied, failed }]) => ({
        suggestionType,
        applied,
        failed,
        yieldRate: applied + failed > 0 ? Math.round((applied / (applied + failed)) * 1000) / 1000 : 0,
      }))
      .sort((a, b) => a.yieldRate - b.yieldRate); // worst-performing types first -- the actionable end of the list

    return { period: { from: from.toISOString(), to: to.toISOString() }, yieldByType };
  }

  /** Score-delta trend for one job -- already fully available via the
   * 'reaudit' action, no new field needed. */
  async getScoreTrend(jobId: string): Promise<ScoreTrendPoint[]> {
    const events = await prisma.remediationCycleEvent.findMany({
      where: { jobId, action: 'reaudit' },
      select: { cycleNumber: true, resolvedCount: true, remainingCount: true, resolutionRate: true, completedAt: true },
      orderBy: { cycleNumber: 'asc' },
    });
    return events.map((e) => ({
      cycleNumber: e.cycleNumber,
      resolvedCount: e.resolvedCount,
      remainingCount: e.remainingCount,
      resolutionRate: e.resolutionRate,
      completedAt: e.completedAt.toISOString(),
    }));
  }

  /** Stuck-issue backlog: issues still open on jobs whose auto-mode run has
   * stopped. Capped at STUCK_ISSUES_JOB_LIMIT jobs per driver table -- not a
   * full tenant scan, see this file's own doc comment. */
  async getStuckIssues(tenantId: string): Promise<StuckIssueEntry[]> {
    const [trials, runs] = await Promise.all([
      prisma.comparisonTrial.findMany({
        where: { autoStatus: 'stopped', job: { tenantId } },
        select: { ninjaJobId: true, job: { select: { input: true, output: true } } },
        take: STUCK_ISSUES_JOB_LIMIT,
      }),
      prisma.pdfAutoRemediationRun.findMany({
        where: { autoStatus: 'stopped', job: { tenantId } },
        select: { jobId: true, job: { select: { input: true, output: true } } },
        take: STUCK_ISSUES_JOB_LIMIT,
      }),
    ]);

    const byCode = new Map<string, { count: number; sampleJobs: StuckIssueSampleJob[] }>();
    const addIssues = (jobId: string | null, input: unknown, output: unknown) => {
      if (!jobId) return;
      const auditReport = (output as Record<string, unknown> | null)?.auditReport as Record<string, unknown> | undefined;
      const issues = (auditReport?.issues as Array<{ code?: string }> | undefined) ?? [];
      for (const issue of issues) {
        if (!issue.code) continue;
        const entry = byCode.get(issue.code) ?? { count: 0, sampleJobs: [] };
        entry.count += 1;
        if (
          !entry.sampleJobs.some((j) => j.jobId === jobId) &&
          entry.sampleJobs.length < STUCK_ISSUES_SAMPLE_LIMIT
        ) {
          entry.sampleJobs.push({ jobId, fileName: extractJobFileName(input, output) });
        }
        byCode.set(issue.code, entry);
      }
    };

    for (const trial of trials) addIssues(trial.ninjaJobId, trial.job?.input, trial.job?.output);
    for (const run of runs) addIssues(run.jobId, run.job?.input, run.job?.output);

    return Array.from(byCode.entries())
      .map(([code, { count, sampleJobs }]) => ({ code, count, sampleJobs }))
      .sort((a, b) => b.count - a.count);
  }
}

export const qualityReportService = new QualityReportService();
