/**
 * ThroughputReportService -- Operational Reports Group 1. Covers the
 * aggregation math (avg/p50/p95, day/week bucketing) and the tenant-scoping
 * on every query, since this report has no new schema and is purely a read
 * over existing Job/RemediationCycleEvent/PdfConcurrencyBudget data.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findMany: vi.fn() },
    remediationCycleEvent: { findMany: vi.fn() },
    pdfConcurrencyBudget: { findUnique: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { throughputReportService } from '../../../../src/services/reports/throughput-report.service';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

function job(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    createdAt: new Date('2026-10-05T00:00:00.000Z'),
    startedAt: new Date('2026-10-05T00:01:00.000Z'), // 60s queue wait
    completedAt: new Date('2026-10-05T00:05:00.000Z'), // 240s initial audit
    ...overrides,
  };
}

describe('ThroughputReportService.getReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([]);
    (prisma.pdfConcurrencyBudget.findUnique as any).mockResolvedValue(null);
  });

  it('computes avg/p50/p95 queue-wait and initial-audit from Job timestamps', async () => {
    (prisma.job.findMany as any)
      .mockResolvedValueOnce([
        job({ id: 'j1', startedAt: new Date('2026-10-05T00:00:10.000Z') }), // 10s wait
        job({ id: 'j2', startedAt: new Date('2026-10-05T00:00:20.000Z') }), // 20s wait
        job({ id: 'j3', startedAt: new Date('2026-10-05T00:00:30.000Z') }), // 30s wait
      ])
      .mockResolvedValueOnce([]); // stuck-jobs query

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.queueWait.count).toBe(3);
    expect(report.queueWait.avgMs).toBe(20000);
    expect((prisma.job.findMany as any).mock.calls[0][0].where.tenantId).toBe('t-1');
  });

  it('skips initialAudit for a job that has not completed yet, without throwing', async () => {
    (prisma.job.findMany as any)
      .mockResolvedValueOnce([job({ id: 'j1', completedAt: null })])
      .mockResolvedValueOnce([]); // stuck-jobs query

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.initialAudit.count).toBe(0);
    expect(report.queueWait.count).toBe(1);
  });

  it('breaks round duration out per RemediationCycleEvent action', async () => {
    (prisma.job.findMany as any).mockResolvedValue([]);
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { action: 'apply_fixes', startedAt: new Date('2026-10-05T00:00:00Z'), completedAt: new Date('2026-10-05T00:01:00Z') },
      { action: 'apply_fixes', startedAt: new Date('2026-10-05T00:00:00Z'), completedAt: new Date('2026-10-05T00:02:00Z') },
      { action: 'reaudit', startedAt: new Date('2026-10-05T00:00:00Z'), completedAt: new Date('2026-10-05T00:00:30Z') },
    ]);

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    const applyFixes = report.roundDuration.find((r) => r.action === 'apply_fixes');
    const reaudit = report.roundDuration.find((r) => r.action === 'reaudit');
    expect(applyFixes).toEqual(expect.objectContaining({ count: 2, avgMs: 90000 }));
    expect(reaudit).toEqual(expect.objectContaining({ count: 1, avgMs: 30000 }));
    expect((prisma.remediationCycleEvent.findMany as any).mock.calls[0][0].where.job).toEqual({ tenantId: 't-1' });
  });

  it('buckets the trend by day when groupBy is day', async () => {
    (prisma.job.findMany as any)
      .mockResolvedValueOnce([
        job({ id: 'j1', createdAt: new Date('2026-10-05T01:00:00Z'), startedAt: new Date('2026-10-05T01:00:10Z') }),
        job({ id: 'j2', createdAt: new Date('2026-10-06T01:00:00Z'), startedAt: new Date('2026-10-06T01:00:20Z') }),
      ])
      .mockResolvedValueOnce([]); // stuck-jobs query

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.trend.map((t) => t.period)).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('includes a stuck job whose remediation-cycle lock has gone stale', async () => {
    (prisma.job.findMany as any)
      .mockResolvedValueOnce([]) // main report query
      .mockResolvedValueOnce([
        { id: 'stuck-1', status: 'PROCESSING', updatedAt: new Date(Date.now() - 25 * 60 * 1000), input: { fileName: 'big.pdf' } },
      ]);

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.stuckJobs).toHaveLength(1);
    expect(report.stuckJobs[0]).toEqual(
      expect.objectContaining({ jobId: 'stuck-1', status: 'PROCESSING', fileName: 'big.pdf' })
    );
  });

  it('reports concurrency budget utilization when a row exists for the tenant', async () => {
    (prisma.job.findMany as any).mockResolvedValue([]);
    (prisma.pdfConcurrencyBudget.findUnique as any).mockResolvedValue({ tenantId: 't-1', totalUnits: 10, unitsInUse: 4 });

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.concurrency).toEqual({ totalUnits: 10, unitsInUse: 4 });
  });

  it('returns null concurrency when the tenant has no budget row yet', async () => {
    (prisma.job.findMany as any).mockResolvedValue([]);

    const report = await throughputReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, groupBy: 'day' });

    expect(report.concurrency).toBeNull();
  });
});
