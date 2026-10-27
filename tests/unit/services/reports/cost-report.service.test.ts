/**
 * CostReportService -- Operational Reports Group 2. UNIONs the two
 * parallel auto-mode driver tables (ComparisonTrial, PdfAutoRemediationRun)
 * for the spend rollup, and reads RemediationCycleEvent.costUsd for the
 * per-round drill-down (the one genuinely new field this group needed).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: { findMany: vi.fn() },
    pdfAutoRemediationRun: { findMany: vi.fn() },
    remediationCycleEvent: { findMany: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { costReportService } from '../../../../src/services/reports/cost-report.service';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

describe('CostReportService.getReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([]);
  });

  it('sums cost across both driver tables', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: 'job-1', autoCostSpentUsd: 0.5, autoStopReason: 'converged', job: { input: null, output: null } },
    ]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-2', autoCostSpentUsd: 1.25, autoStopReason: 'budget_limit', job: { input: null, output: null } },
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.totalSpentUsd).toBe(1.75);
    expect(report.runCount).toBe(2);
    expect(report.avgCostPerRunUsd).toBe(0.875);
  });

  it('includes the job file name from output.originalName, falling back to input', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: 'job-1', autoCostSpentUsd: 0.5, autoStopReason: 'converged', job: { input: { fileName: 'from-input.pdf' }, output: { originalName: 'from-output.pdf' } } },
    ]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-2', autoCostSpentUsd: 1.25, autoStopReason: 'budget_limit', job: { input: { fileName: 'input-only.pdf' }, output: null } },
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.spendByRun.find((r) => r.jobId === 'job-1')?.fileName).toBe('from-output.pdf');
    expect(report.spendByRun.find((r) => r.jobId === 'job-2')?.fileName).toBe('input-only.pdf');
  });

  it('skips a ComparisonTrial row with no linked job (ninjaJobId null)', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: null, autoCostSpentUsd: 5, autoStopReason: 'error', job: null },
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.runCount).toBe(0);
    expect(report.totalSpentUsd).toBe(0);
  });

  it('computes cost-per-page only from runs that have a page count', async () => {
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-1', autoCostSpentUsd: 2, autoStopReason: 'converged', job: { output: { auditReport: { metadata: { pageCount: 100 } } } } },
      { jobId: 'job-2', autoCostSpentUsd: 1, autoStopReason: 'converged', job: { output: null } }, // no page count, excluded
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.avgCostPerPageUsd).toBe(0.02); // 2 / 100, the no-pageCount run excluded from both sides
  });

  it('returns null avgCostPerPageUsd when no run has a page count', async () => {
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-1', autoCostSpentUsd: 2, autoStopReason: 'converged', job: { output: null } },
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.avgCostPerPageUsd).toBeNull();
  });

  it('groups cap-hit frequency by stopReason across both tables, defaulting null to not_stopped', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: 'job-1', autoCostSpentUsd: 0, autoStopReason: 'budget_limit', job: { output: null } },
      { ninjaJobId: 'job-2', autoCostSpentUsd: 0, autoStopReason: null, job: { output: null } },
    ]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-3', autoCostSpentUsd: 0, autoStopReason: 'budget_limit', job: { output: null } },
    ]);

    const report = await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.capHitFrequency).toEqual({ budget_limit: 2, not_stopped: 1 });
  });

  it('scopes both driver-table queries to the job relation tenantId/date range', async () => {
    await costReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    const trialWhere = (prisma.comparisonTrial.findMany as any).mock.calls[0][0].where;
    const runWhere = (prisma.pdfAutoRemediationRun.findMany as any).mock.calls[0][0].where;
    expect(trialWhere.job).toEqual({ tenantId: 't-1', createdAt: { gte: FROM, lte: TO } });
    expect(runWhere.job).toEqual({ tenantId: 't-1', createdAt: { gte: FROM, lte: TO } });
  });
});

describe('CostReportService.getRoundCostTrend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([]);
  });

  it('returns cycle-ordered cost points for a single job, filtered to the ai_analysis action', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { cycleNumber: 1, costUsd: 0.3, completedAt: new Date('2026-10-05T00:00:00Z') },
      { cycleNumber: 2, costUsd: 0.1, completedAt: new Date('2026-10-05T01:00:00Z') },
    ]);

    const trend = await costReportService.getRoundCostTrend('job-1');

    expect(trend).toEqual([
      { cycleNumber: 1, costUsd: 0.3, completedAt: '2026-10-05T00:00:00.000Z' },
      { cycleNumber: 2, costUsd: 0.1, completedAt: '2026-10-05T01:00:00.000Z' },
    ]);
    const call = (prisma.remediationCycleEvent.findMany as any).mock.calls[0][0];
    expect(call.where).toEqual({ jobId: 'job-1', action: 'ai_analysis' });
  });
});
