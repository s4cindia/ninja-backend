/**
 * ReliabilityReportService -- Operational Reports Group 4. Covers both the
 * interruption count (reads the two new RemediationCycleEvent action
 * values) and the failure-reason classifier, which deliberately reads
 * Job.error's existing freeform text at query time rather than requiring a
 * new write-time column -- see the service file's own doc comment.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    remediationCycleEvent: { findMany: vi.fn() },
    job: { findMany: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { reliabilityReportService, classifyErrorMessage } from '../../../../src/services/reports/reliability-report.service';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

describe('classifyErrorMessage', () => {
  it('classifies the real observed size-limit error', () => {
    expect(classifyErrorMessage('PDF file exceeds maximum size of 500MB')).toBe('SIZE_LIMIT_EXCEEDED');
  });

  it('classifies a timeout message regardless of a space in "timed out"', () => {
    expect(classifyErrorMessage('Operation timed out after 30000ms')).toBe('TIMEOUT');
  });

  it('classifies a parse failure', () => {
    expect(classifyErrorMessage('Failed to parse PDF structure: corrupt xref table')).toBe('PARSE_ERROR');
  });

  it('classifies a validation failure', () => {
    expect(classifyErrorMessage('Invalid workflow configuration: validation failed')).toBe('VALIDATION_ERROR');
  });

  it('falls back to UNKNOWN for an unrecognized message', () => {
    expect(classifyErrorMessage('Something went sideways in a way nobody has seen before')).toBe('UNKNOWN');
  });

  it('falls back to UNKNOWN for a null error', () => {
    expect(classifyErrorMessage(null)).toBe('UNKNOWN');
  });
});

describe('ReliabilityReportService.getReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([]);
    (prisma.job.findMany as any).mockResolvedValue([]);
  });

  it('counts interruptions grouped by action', async () => {
    (prisma.remediationCycleEvent.findMany as any).mockResolvedValue([
      { action: 'force_stopped' },
      { action: 'force_stopped' },
      { action: 'orphan_reconciled' },
    ]);

    const report = await reliabilityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.interruptionCount).toBe(3);
    expect(report.interruptionsByAction).toEqual({ force_stopped: 2, orphan_reconciled: 1 });
  });

  it('scopes the interruption query to tenantId via the job relation and to the two interruption actions', async () => {
    await reliabilityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    const call = (prisma.remediationCycleEvent.findMany as any).mock.calls[0][0];
    expect(call.where.job).toEqual({ tenantId: 't-1' });
    expect(call.where.action).toEqual({ in: ['force_stopped', 'orphan_reconciled'] });
  });

  it('buckets FAILED jobs by classified error category', async () => {
    (prisma.job.findMany as any).mockResolvedValue([
      { error: 'PDF file exceeds maximum size of 500MB' },
      { error: 'PDF file exceeds maximum size of 500MB' },
      { error: 'Operation timed out' },
      { error: 'something bizarre' },
      { error: null },
    ]);

    const report = await reliabilityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.failureCount).toBe(5);
    expect(report.failuresByCategory).toEqual({
      SIZE_LIMIT_EXCEEDED: 2,
      TIMEOUT: 1,
      PARSE_ERROR: 0,
      VALIDATION_ERROR: 0,
      UNKNOWN: 2,
    });
  });

  it('scopes the failed-jobs query to tenantId and status FAILED', async () => {
    await reliabilityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    const call = (prisma.job.findMany as any).mock.calls[0][0];
    expect(call.where.tenantId).toBe('t-1');
    expect(call.where.status).toBe('FAILED');
  });
});
