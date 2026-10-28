/**
 * Cost report (Operational Reports Group 2 -- see
 * OPERATIONAL_REPORTS_DESIGN.md). Two auto-mode driver tables exist for the
 * same dual-path reality everywhere else in this codebase --
 * ComparisonTrial (Comparison Study) and PdfAutoRemediationRun (production
 * batch/job-native) -- both carry a cumulative autoCostSpentUsd and an
 * autoStopReason, overwritten in place each round, no history. This report
 * UNIONs both. Per-round cost trend for a single job comes from
 * RemediationCycleEvent.costUsd instead, which IS historical (one row per
 * round, see auto-remediation-loop.service.ts's getRoundAiCostUsd).
 */

import prisma from '../../lib/prisma';
import { extractJobFileName } from './job-filename.util';

export interface CostReportParams {
  tenantId: string;
  from: Date;
  to: Date;
}

export interface SpendEntry {
  jobId: string;
  fileName: string | null;
  source: 'comparison_trial' | 'job_native';
  costUsd: number;
  stopReason: string | null;
  pageCount: number | null;
}

export interface CostReport {
  period: { from: string; to: string };
  totalSpentUsd: number;
  runCount: number;
  avgCostPerRunUsd: number | null;
  avgCostPerPageUsd: number | null;
  capHitFrequency: Record<string, number>;
  spendByRun: SpendEntry[];
}

export interface RoundCostPoint {
  cycleNumber: number;
  costUsd: number | null;
  completedAt: string;
}

function pageCountFrom(output: unknown): number | null {
  const auditReport = (output as Record<string, unknown> | null)?.auditReport as Record<string, unknown> | undefined;
  const metadata = auditReport?.metadata as Record<string, unknown> | undefined;
  const pageCount = metadata?.pageCount;
  return typeof pageCount === 'number' ? pageCount : null;
}

class CostReportService {
  async getReport(params: CostReportParams): Promise<CostReport> {
    const { tenantId, from, to } = params;

    const [trials, runs] = await Promise.all([
      prisma.comparisonTrial.findMany({
        where: { job: { tenantId, createdAt: { gte: from, lte: to } } },
        select: {
          ninjaJobId: true,
          autoCostSpentUsd: true,
          autoStopReason: true,
          job: { select: { input: true, output: true } },
        },
      }),
      prisma.pdfAutoRemediationRun.findMany({
        where: { job: { tenantId, createdAt: { gte: from, lte: to } } },
        select: {
          jobId: true,
          autoCostSpentUsd: true,
          autoStopReason: true,
          job: { select: { input: true, output: true } },
        },
      }),
    ]);

    const spendByRun: SpendEntry[] = [
      ...trials
        .filter((t) => t.ninjaJobId != null)
        .map((t) => ({
          jobId: t.ninjaJobId as string,
          fileName: extractJobFileName(t.job?.input, t.job?.output),
          source: 'comparison_trial' as const,
          costUsd: t.autoCostSpentUsd,
          stopReason: t.autoStopReason,
          pageCount: pageCountFrom(t.job?.output),
        })),
      ...runs.map((r) => ({
        jobId: r.jobId,
        fileName: extractJobFileName(r.job?.input, r.job?.output),
        source: 'job_native' as const,
        costUsd: r.autoCostSpentUsd,
        stopReason: r.autoStopReason,
        pageCount: pageCountFrom(r.job?.output),
      })),
    ];

    const totalSpentUsd = spendByRun.reduce((sum, r) => sum + r.costUsd, 0);
    const runCount = spendByRun.length;

    const runsWithPages = spendByRun.filter((r) => r.pageCount != null && r.pageCount > 0);
    const totalPages = runsWithPages.reduce((sum, r) => sum + (r.pageCount ?? 0), 0);
    const costOfPagedRuns = runsWithPages.reduce((sum, r) => sum + r.costUsd, 0);

    const capHitFrequency: Record<string, number> = {};
    for (const run of spendByRun) {
      const key = run.stopReason ?? 'not_stopped';
      capHitFrequency[key] = (capHitFrequency[key] ?? 0) + 1;
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totalSpentUsd: Math.round(totalSpentUsd * 10000) / 10000,
      runCount,
      avgCostPerRunUsd: runCount > 0 ? Math.round((totalSpentUsd / runCount) * 10000) / 10000 : null,
      avgCostPerPageUsd: totalPages > 0 ? Math.round((costOfPagedRuns / totalPages) * 1_000_000) / 1_000_000 : null,
      capHitFrequency,
      spendByRun,
    };
  }

  /** Per-round cost drill-down for a single job -- the one place this
   * report needs RemediationCycleEvent.costUsd rather than the cumulative
   * driver-table total, since that total has no history. */
  async getRoundCostTrend(jobId: string): Promise<RoundCostPoint[]> {
    const events = await prisma.remediationCycleEvent.findMany({
      where: { jobId, action: 'ai_analysis' },
      select: { cycleNumber: true, costUsd: true, completedAt: true },
      orderBy: { cycleNumber: 'asc' },
    });
    return events.map((e) => ({
      cycleNumber: e.cycleNumber,
      costUsd: e.costUsd,
      completedAt: e.completedAt.toISOString(),
    }));
  }
}

export const costReportService = new CostReportService();
