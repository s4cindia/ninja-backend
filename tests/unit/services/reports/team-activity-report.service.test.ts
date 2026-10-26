/**
 * TeamActivityReportService -- Operational Reports Group 5. Pure
 * aggregation over TeamReview/Job, no new schema. Covers both call-site
 * scopes: tenant-wide (memberUserIds omitted, ADMIN) and team-scoped
 * (memberUserIds provided, self-service TEAM_LEADER/VIEWER).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    teamReview: { findMany: vi.fn() },
    job: { findMany: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { teamActivityReportService } from '../../../../src/services/reports/team-activity-report.service';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

describe('TeamActivityReportService.getReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.teamReview.findMany as any).mockResolvedValue([]);
    (prisma.job.findMany as any).mockResolvedValue([]);
  });

  it('groups review throughput by reviewer and splits OK vs NEEDS_CORRECTION', async () => {
    (prisma.teamReview.findMany as any).mockResolvedValue([
      { reviewedBy: 'tl-1', outcome: 'OK', reviewer: { firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
      { reviewedBy: 'tl-1', outcome: 'OK', reviewer: { firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
      { reviewedBy: 'tl-1', outcome: 'NEEDS_CORRECTION', reviewer: { firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
    ]);

    const report = await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.reviewThroughput).toEqual([
      { reviewerId: 'tl-1', reviewerName: 'Tess Lead', reviewerEmail: 'tl@x.com', okCount: 2, needsCorrectionCount: 1, total: 3 },
    ]);
  });

  it('falls back to email when the reviewer has no first/last name', async () => {
    (prisma.teamReview.findMany as any).mockResolvedValue([
      { reviewedBy: 'tl-2', outcome: 'OK', reviewer: { firstName: null, lastName: null, email: 'noname@x.com' } },
    ]);

    const report = await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.reviewThroughput[0].reviewerName).toBe('noname@x.com');
  });

  it('groups ownership by owner and buckets status into completed/failed/inProgress', async () => {
    (prisma.job.findMany as any).mockResolvedValue([
      { userId: 'exec-1', status: 'COMPLETED', user: { firstName: 'Eve', lastName: 'Exec', email: 'e@x.com' } },
      { userId: 'exec-1', status: 'FAILED', user: { firstName: 'Eve', lastName: 'Exec', email: 'e@x.com' } },
      { userId: 'exec-1', status: 'PROCESSING', user: { firstName: 'Eve', lastName: 'Exec', email: 'e@x.com' } },
      { userId: 'exec-1', status: 'QUEUED', user: { firstName: 'Eve', lastName: 'Exec', email: 'e@x.com' } },
    ]);

    const report = await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.ownership).toEqual([
      { ownerId: 'exec-1', ownerName: 'Eve Exec', ownerEmail: 'e@x.com', totalJobs: 4, completedJobs: 1, failedJobs: 1, inProgressJobs: 2 },
    ]);
  });

  it('scopes both queries to tenantId only when memberUserIds is omitted (ADMIN view)', async () => {
    await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    const reviewWhere = (prisma.teamReview.findMany as any).mock.calls[0][0].where;
    const jobWhere = (prisma.job.findMany as any).mock.calls[0][0].where;
    expect(reviewWhere.job).toEqual({ tenantId: 't-1' });
    expect(reviewWhere.reviewedBy).toBeUndefined();
    expect(jobWhere.tenantId).toBe('t-1');
    expect(jobWhere.userId).toBeUndefined();
  });

  it('additionally scopes to memberUserIds when provided (self-service team view)', async () => {
    await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO, memberUserIds: ['leader-1', 'member-2'] });

    const reviewWhere = (prisma.teamReview.findMany as any).mock.calls[0][0].where;
    const jobWhere = (prisma.job.findMany as any).mock.calls[0][0].where;
    expect(reviewWhere.reviewedBy).toEqual({ in: ['leader-1', 'member-2'] });
    expect(jobWhere.userId).toEqual({ in: ['leader-1', 'member-2'] });
  });

  it('sorts both lists with the busiest reviewer/owner first', async () => {
    (prisma.teamReview.findMany as any).mockResolvedValue([
      { reviewedBy: 'tl-low', outcome: 'OK', reviewer: { firstName: 'Low', lastName: 'Vol', email: 'l@x.com' } },
      { reviewedBy: 'tl-high', outcome: 'OK', reviewer: { firstName: 'High', lastName: 'Vol', email: 'h@x.com' } },
      { reviewedBy: 'tl-high', outcome: 'OK', reviewer: { firstName: 'High', lastName: 'Vol', email: 'h@x.com' } },
    ]);

    const report = await teamActivityReportService.getReport({ tenantId: 't-1', from: FROM, to: TO });

    expect(report.reviewThroughput.map((r) => r.reviewerId)).toEqual(['tl-high', 'tl-low']);
  });
});
