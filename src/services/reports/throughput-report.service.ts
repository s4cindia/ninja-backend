/**
 * Throughput / Time report (Operational Reports Group 1 -- see
 * OPERATIONAL_REPORTS_DESIGN.md). Pure aggregation over data that already
 * exists -- no new schema. Queue wait and initial-audit duration come
 * straight off Job.createdAt/startedAt/completedAt (the PDF pipeline marks a
 * job COMPLETED right after the first audit; remediation, manual or auto, is
 * a separate later action, so completedAt - startedAt is genuinely "initial
 * audit duration," not the whole remediation lifetime). Round-duration
 * breakdown comes off RemediationCycleEvent, which both the manual
 * remediation flow and the auto-mode loop already write to per action.
 */

import prisma from '../../lib/prisma';
import { STALE_LOCK_MS } from '../pdf/remediation-cycle-lock.service';

export interface ThroughputReportParams {
  tenantId: string;
  from: Date;
  to: Date;
  groupBy: 'day' | 'week';
}

export interface DurationSummary {
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  count: number;
}

export interface RoundDurationEntry extends DurationSummary {
  action: string;
}

export interface TrendPoint {
  period: string;
  queueWaitAvgMs: number | null;
  initialAuditAvgMs: number | null;
  jobCount: number;
}

export interface StuckJobEntry {
  jobId: string;
  status: string;
  updatedAt: string;
  stuckForMs: number;
  fileName: string | null;
}

export interface ThroughputReport {
  period: { from: string; to: string; groupBy: 'day' | 'week' };
  queueWait: DurationSummary;
  initialAudit: DurationSummary;
  roundDuration: RoundDurationEntry[];
  trend: TrendPoint[];
  stuckJobs: StuckJobEntry[];
  concurrency: { totalUnits: number; unitsInUse: number } | null;
}

const REPORTED_JOB_TYPES = ['PDF_ACCESSIBILITY', 'EPUB_ACCESSIBILITY'] as const;
const ROUND_ACTIONS = ['ai_analysis', 'apply_fixes', 'reaudit'] as const;
const STUCK_JOB_LIMIT = 50;

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function summarize(valuesMs: number[]): DurationSummary {
  if (valuesMs.length === 0) return { avgMs: null, p50Ms: null, p95Ms: null, count: 0 };
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const avgMs = Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length);
  return { avgMs, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), count: sorted.length };
}

/** ISO date ("day") or Monday-anchored ISO week start ("week"), used as the
 * trend bucket key -- stable and sortable as a plain string either way. */
function bucketKey(date: Date, groupBy: 'day' | 'week'): string {
  if (groupBy === 'day') return date.toISOString().slice(0, 10);
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

class ThroughputReportService {
  async getReport(params: ThroughputReportParams): Promise<ThroughputReport> {
    const { tenantId, from, to, groupBy } = params;

    const jobs = await prisma.job.findMany({
      where: {
        tenantId,
        type: { in: [...REPORTED_JOB_TYPES] },
        createdAt: { gte: from, lte: to },
      },
      select: { id: true, createdAt: true, startedAt: true, completedAt: true },
    });

    const queueWaitMs: number[] = [];
    const initialAuditMs: number[] = [];
    const byBucket = new Map<string, { queueWait: number[]; initialAudit: number[] }>();

    for (const job of jobs) {
      const bucket = byBucket.get(bucketKey(job.createdAt, groupBy)) ?? { queueWait: [], initialAudit: [] };
      if (job.startedAt) {
        const ms = job.startedAt.getTime() - job.createdAt.getTime();
        queueWaitMs.push(ms);
        bucket.queueWait.push(ms);
      }
      if (job.startedAt && job.completedAt) {
        const ms = job.completedAt.getTime() - job.startedAt.getTime();
        initialAuditMs.push(ms);
        bucket.initialAudit.push(ms);
      }
      byBucket.set(bucketKey(job.createdAt, groupBy), bucket);
    }

    const trend: TrendPoint[] = Array.from(byBucket.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, values]) => ({
        period,
        queueWaitAvgMs: summarize(values.queueWait).avgMs,
        initialAuditAvgMs: summarize(values.initialAudit).avgMs,
        jobCount: Math.max(values.queueWait.length, values.initialAudit.length),
      }));

    const cycleEvents = await prisma.remediationCycleEvent.findMany({
      where: {
        job: { tenantId },
        startedAt: { gte: from, lte: to },
        action: { in: [...ROUND_ACTIONS] },
      },
      select: { action: true, startedAt: true, completedAt: true },
    });

    const durationsByAction = new Map<string, number[]>();
    for (const event of cycleEvents) {
      const ms = event.completedAt.getTime() - event.startedAt.getTime();
      const list = durationsByAction.get(event.action) ?? [];
      list.push(ms);
      durationsByAction.set(event.action, list);
    }
    const roundDuration: RoundDurationEntry[] = ROUND_ACTIONS.filter((action) => durationsByAction.has(action)).map(
      (action) => ({ action, ...summarize(durationsByAction.get(action) ?? []) })
    );

    // Stuck-job radar: same staleness threshold remediation-cycle-lock.service.ts
    // already uses, applied directly in SQL rather than per-job getLockStatus
    // calls (which would be N+1). A job with no lock at all (never entered a
    // remediation cycle) is judged by updatedAt instead -- still a reasonable
    // "nothing has touched this in 20+ minutes" signal for QUEUED/PROCESSING.
    const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
    const stuckJobRows = await prisma.job.findMany({
      where: {
        tenantId,
        status: { in: ['QUEUED', 'PROCESSING'] },
        OR: [
          { remediationCycleLockedAt: { lt: staleThreshold } },
          { remediationCycleLockedAt: null, updatedAt: { lt: staleThreshold } },
        ],
      },
      select: { id: true, status: true, updatedAt: true, input: true },
      take: STUCK_JOB_LIMIT,
      orderBy: { updatedAt: 'asc' },
    });

    const stuckJobs: StuckJobEntry[] = stuckJobRows.map((job) => ({
      jobId: job.id,
      status: job.status,
      updatedAt: job.updatedAt.toISOString(),
      stuckForMs: Date.now() - job.updatedAt.getTime(),
      fileName: ((job.input as Record<string, unknown> | null)?.fileName as string | undefined) ?? null,
    }));

    const budget = await prisma.pdfConcurrencyBudget.findUnique({ where: { tenantId } });

    return {
      period: { from: from.toISOString(), to: to.toISOString(), groupBy },
      queueWait: summarize(queueWaitMs),
      initialAudit: summarize(initialAuditMs),
      roundDuration,
      trend,
      stuckJobs,
      concurrency: budget ? { totalUnits: budget.totalUnits, unitsInUse: budget.unitsInUse } : null,
    };
  }
}

export const throughputReportService = new ThroughputReportService();
