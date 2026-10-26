/**
 * admin/reports.routes -- auth gating and request validation only. The
 * aggregation math itself is covered by throughput-report.service.test.ts;
 * this file mocks the service so it only asserts routing/auth/param
 * handling, following admin/teams.routes.test.ts's supertest pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockGetReport = vi.fn();
const mockGetTeamActivityReport = vi.fn();
const mockGetCostReport = vi.fn();
const mockGetRoundCostTrend = vi.fn();
const mockGetReliabilityReport = vi.fn();
const mockGetQualityReport = vi.fn();
const mockGetStuckIssues = vi.fn();
const mockGetScoreTrend = vi.fn();
const mockJobFindUnique = vi.fn();

vi.mock('../../../../src/services/reports/throughput-report.service', () => ({
  throughputReportService: { getReport: (...args: unknown[]) => mockGetReport(...args) },
}));

vi.mock('../../../../src/services/reports/team-activity-report.service', () => ({
  teamActivityReportService: { getReport: (...args: unknown[]) => mockGetTeamActivityReport(...args) },
}));

vi.mock('../../../../src/services/reports/cost-report.service', () => ({
  costReportService: {
    getReport: (...args: unknown[]) => mockGetCostReport(...args),
    getRoundCostTrend: (...args: unknown[]) => mockGetRoundCostTrend(...args),
  },
}));

vi.mock('../../../../src/services/reports/reliability-report.service', () => ({
  reliabilityReportService: { getReport: (...args: unknown[]) => mockGetReliabilityReport(...args) },
}));

vi.mock('../../../../src/services/reports/quality-report.service', () => ({
  qualityReportService: {
    getReport: (...args: unknown[]) => mockGetQualityReport(...args),
    getStuckIssues: (...args: unknown[]) => mockGetStuckIssues(...args),
    getScoreTrend: (...args: unknown[]) => mockGetScoreTrend(...args),
  },
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: (...args: unknown[]) => mockJobFindUnique(...args) } },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let mockUser: Record<string, unknown> = {
  userId: 'admin-1', id: 'admin-1',
  role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com',
};

vi.mock('../../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = mockUser;
    next();
  },
}));

import adminReportsRoutes from '../../../../src/routes/admin/reports.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminReportsRoutes);
  return app;
}

describe('admin/reports.routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { userId: 'admin-1', id: 'admin-1', role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com' };
    mockGetReport.mockResolvedValue({ period: {}, queueWait: {}, initialAudit: {}, roundDuration: [], trend: [], stuckJobs: [], concurrency: null });
    mockGetTeamActivityReport.mockResolvedValue({ period: {}, reviewThroughput: [], ownership: [] });
    mockGetCostReport.mockResolvedValue({ period: {}, totalSpentUsd: 0, runCount: 0, avgCostPerRunUsd: null, avgCostPerPageUsd: null, capHitFrequency: {}, spendByRun: [] });
    mockGetRoundCostTrend.mockResolvedValue([]);
    mockGetReliabilityReport.mockResolvedValue({ period: {}, interruptionCount: 0, interruptionsByAction: {}, failureCount: 0, failuresByCategory: {} });
    mockGetQualityReport.mockResolvedValue({ period: {}, yieldByType: [] });
    mockGetStuckIssues.mockResolvedValue([]);
    mockGetScoreTrend.mockResolvedValue([]);
    mockJobFindUnique.mockResolvedValue({ tenantId: 't-1' });
  });

  it('returns 403 for a non-ADMIN caller', async () => {
    mockUser = { ...mockUser, role: 'USER' };
    const res = await request(buildApp()).get('/admin/reports/throughput');
    expect(res.status).toBe(403);
    expect(mockGetReport).not.toHaveBeenCalled();
  });

  it('returns 400 when the caller has no tenantId', async () => {
    mockUser = { ...mockUser, tenantId: undefined };
    const res = await request(buildApp()).get('/admin/reports/throughput');
    expect(res.status).toBe(400);
  });

  it('defaults to a 30-day window and day grouping when no query params are given', async () => {
    const res = await request(buildApp()).get('/admin/reports/throughput');
    expect(res.status).toBe(200);
    const call = mockGetReport.mock.calls[0][0];
    expect(call.tenantId).toBe('t-1');
    expect(call.groupBy).toBe('day');
    expect(call.to.getTime() - call.from.getTime()).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -3);
  });

  it('rejects a range wider than 90 days', async () => {
    const res = await request(buildApp()).get('/admin/reports/throughput?from=2026-01-01&to=2026-12-31');
    expect(res.status).toBe(422);
    expect(mockGetReport).not.toHaveBeenCalled();
  });

  it('rejects from after to', async () => {
    const res = await request(buildApp()).get('/admin/reports/throughput?from=2026-10-10&to=2026-10-01');
    expect(res.status).toBe(422);
  });

  it('passes an explicit week groupBy through to the service', async () => {
    const res = await request(buildApp()).get(
      '/admin/reports/throughput?from=2026-10-01&to=2026-10-15&groupBy=week'
    );
    expect(res.status).toBe(200);
    expect(mockGetReport.mock.calls[0][0].groupBy).toBe('week');
  });

  it('returns 500 (not a crash) when the service throws', async () => {
    mockGetReport.mockRejectedValueOnce(new Error('db exploded'));
    const res = await request(buildApp()).get('/admin/reports/throughput');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  describe('GET /admin/reports/team-activity', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'TEAM_LEADER' };
      const res = await request(buildApp()).get('/admin/reports/team-activity');
      expect(res.status).toBe(403);
      expect(mockGetTeamActivityReport).not.toHaveBeenCalled();
    });

    it('delegates to teamActivityReportService with no memberUserIds filter (tenant-wide)', async () => {
      const res = await request(buildApp()).get('/admin/reports/team-activity');
      expect(res.status).toBe(200);
      const call = mockGetTeamActivityReport.mock.calls[0][0];
      expect(call.tenantId).toBe('t-1');
      expect(call.memberUserIds).toBeUndefined();
    });

    it('rejects a range wider than 90 days', async () => {
      const res = await request(buildApp()).get('/admin/reports/team-activity?from=2026-01-01&to=2026-12-31');
      expect(res.status).toBe(422);
      expect(mockGetTeamActivityReport).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/reports/cost', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/cost');
      expect(res.status).toBe(403);
      expect(mockGetCostReport).not.toHaveBeenCalled();
    });

    it('delegates to costReportService with the tenant-scoped date range', async () => {
      const res = await request(buildApp()).get('/admin/reports/cost?from=2026-10-01&to=2026-10-15');
      expect(res.status).toBe(200);
      expect(mockGetCostReport).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't-1' })
      );
    });

    it('rejects a range wider than 90 days', async () => {
      const res = await request(buildApp()).get('/admin/reports/cost?from=2026-01-01&to=2026-12-31');
      expect(res.status).toBe(422);
      expect(mockGetCostReport).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/reports/cost/:jobId/rounds', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/cost/job-1/rounds');
      expect(res.status).toBe(403);
      expect(mockGetRoundCostTrend).not.toHaveBeenCalled();
    });

    it('returns 404 without calling the service when the job belongs to a different tenant', async () => {
      mockJobFindUnique.mockResolvedValue({ tenantId: 'some-other-tenant' });
      const res = await request(buildApp()).get('/admin/reports/cost/job-1/rounds');
      expect(res.status).toBe(404);
      expect(mockGetRoundCostTrend).not.toHaveBeenCalled();
    });

    it('returns 404 without calling the service when the job does not exist', async () => {
      mockJobFindUnique.mockResolvedValue(null);
      const res = await request(buildApp()).get('/admin/reports/cost/job-1/rounds');
      expect(res.status).toBe(404);
      expect(mockGetRoundCostTrend).not.toHaveBeenCalled();
    });

    it('delegates to getRoundCostTrend once tenant ownership is confirmed', async () => {
      const res = await request(buildApp()).get('/admin/reports/cost/job-1/rounds');
      expect(res.status).toBe(200);
      expect(mockGetRoundCostTrend).toHaveBeenCalledWith('job-1');
      expect(res.body.data.jobId).toBe('job-1');
    });
  });

  describe('GET /admin/reports/reliability', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/reliability');
      expect(res.status).toBe(403);
      expect(mockGetReliabilityReport).not.toHaveBeenCalled();
    });

    it('delegates to reliabilityReportService with the tenant-scoped date range', async () => {
      const res = await request(buildApp()).get('/admin/reports/reliability');
      expect(res.status).toBe(200);
      expect(mockGetReliabilityReport).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't-1' })
      );
    });

    it('rejects a range wider than 90 days (reliability)', async () => {
      const res = await request(buildApp()).get('/admin/reports/reliability?from=2026-01-01&to=2026-12-31');
      expect(res.status).toBe(422);
      expect(mockGetReliabilityReport).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/reports/quality', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/quality');
      expect(res.status).toBe(403);
      expect(mockGetQualityReport).not.toHaveBeenCalled();
    });

    it('delegates to qualityReportService with the tenant-scoped date range', async () => {
      const res = await request(buildApp()).get('/admin/reports/quality');
      expect(res.status).toBe(200);
      expect(mockGetQualityReport).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't-1' })
      );
    });

    it('rejects a range wider than 90 days (quality)', async () => {
      const res = await request(buildApp()).get('/admin/reports/quality?from=2026-01-01&to=2026-12-31');
      expect(res.status).toBe(422);
      expect(mockGetQualityReport).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/reports/quality/stuck-issues', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/quality/stuck-issues');
      expect(res.status).toBe(403);
      expect(mockGetStuckIssues).not.toHaveBeenCalled();
    });

    it('delegates to getStuckIssues with the caller tenantId, no date range needed', async () => {
      const res = await request(buildApp()).get('/admin/reports/quality/stuck-issues');
      expect(res.status).toBe(200);
      expect(mockGetStuckIssues).toHaveBeenCalledWith('t-1');
    });
  });

  describe('GET /admin/reports/quality/:jobId/score-trend', () => {
    it('returns 403 for a non-ADMIN caller', async () => {
      mockUser = { ...mockUser, role: 'USER' };
      const res = await request(buildApp()).get('/admin/reports/quality/job-1/score-trend');
      expect(res.status).toBe(403);
      expect(mockGetScoreTrend).not.toHaveBeenCalled();
    });

    it('returns 404 without calling the service when the job belongs to a different tenant', async () => {
      mockJobFindUnique.mockResolvedValue({ tenantId: 'some-other-tenant' });
      const res = await request(buildApp()).get('/admin/reports/quality/job-1/score-trend');
      expect(res.status).toBe(404);
      expect(mockGetScoreTrend).not.toHaveBeenCalled();
    });

    it('delegates to getScoreTrend once tenant ownership is confirmed', async () => {
      const res = await request(buildApp()).get('/admin/reports/quality/job-1/score-trend');
      expect(res.status).toBe(200);
      expect(mockGetScoreTrend).toHaveBeenCalledWith('job-1');
      expect(res.body.data.jobId).toBe('job-1');
    });
  });
});
