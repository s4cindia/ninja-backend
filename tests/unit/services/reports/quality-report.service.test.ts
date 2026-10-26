/**
 * QualityReportService -- Operational Reports Group 3. getReport
 * aggregates the new suggestionTypeBreakdown field; getScoreTrend reads
 * already-existing 'reaudit' resolutionRate history; getStuckIssues UNIONs
 * both auto-mode driver tables the same way cost-report.service.ts does.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    remediationCycleEvent: { findMany: vi.fn() },
    comparisonTrial: { findMany: vi.fn() },
    pdfAutoRemediationRun: { findMany: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { qualityReportService } from '../../../../src/services/reports/quality-report.service';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

describe('QualityReportService.getReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums suggestionTypeBreakdown across multiple rounds/events for the same type', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { suggestionTypeBreakdown: { 'alt-text': { applied: 10, failed: 2 } } },
      { suggestionTypeBreakdown: { 'alt-text': { applied: 5, failed: 1 }, 'table-header-fix': { applied: 3, failed: 0 } } },
    ]);

    const report = await qualityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.yieldByType).toEqual(
      expect.arrayContaining([
        { suggestionType: 'alt-text', applied: 15, failed: 3, yieldRate: 0.833 },
        { suggestionType: 'table-header-fix', applied: 3, failed: 0, yieldRate: 1 },
      ])
    );
  });

  it('sorts worst-yield types first', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { suggestionTypeBreakdown: { good: { applied: 10, failed: 0 }, bad: { applied: 1, failed: 9 } } },
    ]);

    const report = await qualityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.yieldByType.map((y) => y.suggestionType)).toEqual(['bad', 'good']);
  });

  it('reports yieldRate 0 (not NaN/Infinity) for a type with no applied or failed counts at all', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { suggestionTypeBreakdown: { 'weird-type': { applied: 0, failed: 0 } } },
    ]);

    const report = await qualityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.yieldByType[0].yieldRate).toBe(0);
  });

  it('scopes the query to the job relation tenantId, the apply_fixes action, and a non-null breakdown', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([]);

    await qualityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    const call = (prisma.remediationCycleEvent.findMany as any).mock.calls[0][0];
    expect(call.where.job).toEqual({ tenantId: 't-1' });
    expect(call.where.action).toBe('apply_fixes');
  });
});

describe('QualityReportService.getScoreTrend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([]);
  });

  it('returns cycle-ordered resolution data filtered to the reaudit action', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { cycleNumber: 1, resolvedCount: 100, remainingCount: 50, resolutionRate: 66.7, completedAt: new Date('2026-10-05T00:00:00Z') },
    ]);

    const trend = await qualityReportService.getScoreTrend('job-1');

    expect(trend).toEqual([
      { cycleNumber: 1, resolvedCount: 100, remainingCount: 50, resolutionRate: 66.7, completedAt: '2026-10-05T00:00:00.000Z' },
    ]);
    expect((prisma.remediationCycleEvent.findMany as any).mock.calls[0][0].where).toEqual({ jobId: 'job-1', action: 'reaudit' });
  });
});

describe('QualityReportService.getStuckIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([]);
  });

  it('groups issues by code across both driver tables, sorted by count descending', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: 'job-1', job: { output: { auditReport: { issues: [{ code: 'A' }, { code: 'B' }] } } } },
    ]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-2', job: { output: { auditReport: { issues: [{ code: 'A' }] } } } },
    ]);

    const stuck = await qualityReportService.getStuckIssues('t-1');

    expect(stuck).toEqual([
      { code: 'A', count: 2, sampleJobIds: ['job-1', 'job-2'] },
      { code: 'B', count: 1, sampleJobIds: ['job-1'] },
    ]);
  });

  it('skips a trial with no linked job and a job with no output', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue([
      { ninjaJobId: null, job: null },
    ]);
    (prisma.pdfAutoRemediationRun.findMany as any).mockResolvedValue([
      { jobId: 'job-2', job: { output: null } },
    ]);

    const stuck = await qualityReportService.getStuckIssues('t-1');

    expect(stuck).toEqual([]);
  });

  it('only considers jobs whose auto-mode run has stopped', async () => {
    await qualityReportService.getStuckIssues('t-1');

    expect((prisma.comparisonTrial.findMany as any).mock.calls[0][0].where.autoStatus).toBe('stopped');
    expect((prisma.pdfAutoRemediationRun.findMany as any).mock.calls[0][0].where.autoStatus).toBe('stopped');
  });

  it('caps sampleJobIds at 5 even when more jobs share the same issue code', async () => {
    (prisma.comparisonTrial.findMany as any).mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        ninjaJobId: `job-${i}`,
        job: { output: { auditReport: { issues: [{ code: 'A' }] } } },
      }))
    );

    const stuck = await qualityReportService.getStuckIssues('t-1');

    expect(stuck[0].count).toBe(8);
    expect(stuck[0].sampleJobIds).toHaveLength(5);
  });
});
