/**
 * JobController -- covers the `auditReport` flattening fix for PDF
 * accessibility jobs. Real incident (2026-10-20): both the single-file
 * (accessibility.processor.ts) and batch (pdf-batch-orchestrator.service.ts)
 * PDF audit paths persist `Job.output` as
 * `{ auditReport: AuditReport, fileName, scanLevel, type, ... }` -- the real
 * score/issues live nested under `auditReport`, never flattened to the
 * top-level score/summary/combinedIssues shape the generic Jobs > :jobId
 * detail page (frontend JobDetails.tsx, via parseJobOutput) reads. Every PDF
 * audit job rendered "Score 0 / No detailed issues available" despite having
 * real audit data, confirmed live on a job with a real score of 37 and
 * 11991 issues.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findMany: vi.fn(), count: vi.fn() },
    teamMembership: { findMany: vi.fn(), findFirst: vi.fn() },
    teamReview: { findMany: vi.fn() },
  },
}));
vi.mock('../../../src/services/queue.service', () => ({
  queueService: { getJobStatus: vi.fn() },
}));
vi.mock('../../../src/services/reports/team-activity-report.service', () => ({
  teamActivityReportService: { getReport: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { queueService } from '../../../src/services/queue.service';
import { teamActivityReportService } from '../../../src/services/reports/team-activity-report.service';
import { jobController } from '../../../src/controllers/job.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { id: 'job-1' },
    query: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

const PDF_BATCH_SHAPED_OUTPUT = {
  fileName: 'FMHE_PDF.pdf',
  scanLevel: 'comprehensive',
  type: 'PDF_ACCESSIBILITY',
  dbJobId: 'job-1',
  auditReport: {
    jobId: 'job-1',
    fileName: 'FMHE_PDF.pdf',
    score: 37,
    issues: [
      { id: 'i1', code: 'MATTERHORN-01-001', severity: 'critical', message: 'Missing tag' },
      { id: 'i2', code: 'MATTERHORN-13-001', severity: 'serious', message: 'Missing alt text' },
    ],
    summary: { critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 },
    metadata: { pageCount: 2040 },
  },
};

const ALREADY_FLAT_EPUB_OUTPUT = {
  jobId: 'job-2',
  fileName: 'book.epub',
  score: 85,
  isValid: true,
  isAccessible: true,
  epubVersion: '3.0',
  summary: { critical: 0, serious: 1, moderate: 2, minor: 0, total: 3 },
  combinedIssues: [{ id: 'e1', code: 'epub-type-has-matching-role', severity: 'serious' }],
};

describe('JobController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get() -- GET /jobs/:id (JobDetails.tsx\'s data source)', () => {
    it('flattens a PDF audit job\'s nested auditReport onto the top-level output fields', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-1',
        type: 'PDF_ACCESSIBILITY',
        status: 'COMPLETED',
        output: PDF_BATCH_SHAPED_OUTPUT,
      });

      const res = makeRes();
      await jobController.get(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(37);
      expect(output.summary).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 });
      expect(output.combinedIssues).toHaveLength(2);
      expect(output.combinedIssues[0]).toEqual(
        expect.objectContaining({ code: 'MATTERHORN-01-001', severity: 'critical' })
      );
      // Preserves the original nested shape too, for PdfAuditResultsPage.tsx
      // and every other consumer that reads output.auditReport directly.
      expect(output.auditReport).toBe(PDF_BATCH_SHAPED_OUTPUT.auditReport);
    });

    it('derives isAccessible using the same score>=70 && zero-critical threshold EPUB audits use', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-1',
        type: 'PDF_ACCESSIBILITY',
        status: 'COMPLETED',
        output: PDF_BATCH_SHAPED_OUTPUT, // score 37, 1 critical issue
      });

      const res = makeRes();
      await jobController.get(makeReq(), res, next);

      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.isAccessible).toBe(false);
      expect(output.isValid).toBe(true);
    });

    it('does not touch an already-flat output shape (EPUB jobs)', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-2',
        type: 'EPUB_ACCESSIBILITY',
        status: 'COMPLETED',
        output: ALREADY_FLAT_EPUB_OUTPUT,
      });

      const res = makeRes();
      await jobController.get(makeReq({ params: { id: 'job-2' } }), res, next);

      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(85);
      expect(output.summary).toEqual({ critical: 0, serious: 1, moderate: 2, minor: 0, total: 3 });
      expect(output.combinedIssues).toEqual(ALREADY_FLAT_EPUB_OUTPUT.combinedIssues);
    });

    it('still defaults a job with no output at all to the zero-value shape instead of throwing', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-3',
        type: 'PDF_ACCESSIBILITY',
        status: 'PROCESSING',
        output: null,
      });

      const res = makeRes();
      await jobController.get(makeReq({ params: { id: 'job-3' } }), res, next);

      expect(next).not.toHaveBeenCalled();
      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(0);
      expect(output.combinedIssues).toEqual([]);
    });
  });

  describe('list() -- GET /jobs', () => {
    it('also flattens auditReport for PDF jobs returned in the list', async () => {
      (prisma.job.findMany as any).mockResolvedValue([
        { id: 'job-1', type: 'PDF_ACCESSIBILITY', status: 'COMPLETED', output: PDF_BATCH_SHAPED_OUTPUT, editorialDocument: null },
      ]);
      (prisma.job.count as any).mockResolvedValue(1);

      const res = makeRes();
      await jobController.list(makeReq({ params: {} }), res, next);

      const job = (res.json as any).mock.calls[0][0].data.jobs[0];
      expect(job.output.score).toBe(37);
      expect(job.output.combinedIssues).toHaveLength(2);
    });
  });

  describe('listTeamJobs() -- GET /jobs/team (RBAC Phase 3 discovery)', () => {
    beforeEach(() => {
      (prisma.job.findMany as any).mockResolvedValue([]);
      (prisma.job.count as any).mockResolvedValue(0);
      (prisma.teamReview.findMany as any).mockResolvedValue([]);
    });

    it('includes the owner\'s name/email in the select, not just the raw userId (RBAC frontend PR #360 follow-up)', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      const selectArg = (prisma.job.findMany as any).mock.calls[0][0].select;
      expect(selectArg.user).toEqual({ select: { id: true, firstName: true, lastName: true, email: true } });
    });

    it('TEAM_LEADER sees jobs from every member of their team, not just their own', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }]) // caller's qualifying membership
        .mockResolvedValueOnce([{ userId: 'leader-1' }, { userId: 'member-2' }]); // team roster

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', userId: { in: ['leader-1', 'member-2'] } },
        })
      );
      expect(prisma.job.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', userId: { in: ['leader-1', 'member-2'] } },
      });
    });

    it('VIEWER gets the same read access as TEAM_LEADER', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }, { userId: 'viewer-1' }]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'viewer-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', userId: { in: ['leader-1', 'viewer-1'] } },
        })
      );
    });

    it('rejects a caller with no qualifying team membership (plain EXECUTIVE or no team at all)', async () => {
      (prisma.teamMembership.findMany as any).mockResolvedValueOnce([]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'exec-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = (next as any).mock.calls[0][0];
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('NOT_TEAM_LEADER_OR_VIEWER');
      expect(prisma.job.findMany).not.toHaveBeenCalled();
      // Short-circuits before resolving the team roster at all.
      expect(prisma.teamMembership.findMany).toHaveBeenCalledTimes(1);
    });

    it('still applies pagination/status/type filters on top of the team scope', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);

      const res = makeRes();
      await jobController.listTeamJobs(
        makeReq({
          user: { id: 'leader-1', tenantId: 'tenant-1' },
          query: { page: '2', limit: '5', status: 'COMPLETED', type: 'PDF_ACCESSIBILITY' },
        } as any),
        res,
        next
      );

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant-1',
            userId: { in: ['leader-1'] },
            status: 'COMPLETED',
            type: 'PDF_ACCESSIBILITY',
          },
          skip: 5,
          take: 5,
        })
      );
    });

    it('always ANDs tenantId with the team-member userId filter -- a same-userId job in another tenant can never leak', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      const where = (prisma.job.findMany as any).mock.calls[0][0].where;
      expect(where.tenantId).toBe('tenant-1');
      expect(where.userId).toEqual({ in: ['leader-1'] });
    });

    it('attaches reviewBlocked per job from each job\'s most recent TeamReview', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);
      (prisma.job.findMany as any).mockResolvedValue([
        { id: 'job-blocked', type: 'PDF_ACCESSIBILITY', status: 'COMPLETED', output: null },
        { id: 'job-ok', type: 'PDF_ACCESSIBILITY', status: 'COMPLETED', output: null },
        { id: 'job-unreviewed', type: 'PDF_ACCESSIBILITY', status: 'COMPLETED', output: null },
      ]);
      (prisma.job.count as any).mockResolvedValue(3);
      // Already in "ordered by reviewedAt desc" order, as the real query
      // would return -- job-blocked's most recent row (first occurrence) is
      // NEEDS_CORRECTION; its older OK row later in the array is ignored.
      (prisma.teamReview.findMany as any).mockResolvedValue([
        { jobId: 'job-blocked', outcome: 'NEEDS_CORRECTION' },
        { jobId: 'job-ok', outcome: 'OK' },
        { jobId: 'job-blocked', outcome: 'OK' },
      ]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      const jobs = (res.json as any).mock.calls[0][0].data.jobs;
      expect(jobs.find((j: any) => j.id === 'job-blocked').reviewBlocked).toBe(true);
      expect(jobs.find((j: any) => j.id === 'job-ok').reviewBlocked).toBe(false);
      expect(jobs.find((j: any) => j.id === 'job-unreviewed').reviewBlocked).toBe(false);
    });

    it('does not query TeamReview when the page is empty', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);

      const res = makeRes();
      await jobController.listTeamJobs(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(prisma.teamReview.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listTeamExecutives() -- GET /jobs/team/executives (Team Leader upload-assignment roster)', () => {
    it('rejects a caller who does not lead any team at all (plain EXECUTIVE, VIEWER, or no team)', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce(null);

      const res = makeRes();
      await jobController.listTeamExecutives(makeReq({ user: { id: 'exec-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = (next as any).mock.calls[0][0];
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('NOT_TEAM_LEADER');
      // Short-circuits before ever querying the roster itself.
      expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
    });

    it('a team-level VIEWER (read-only oversight) does NOT get this roster, unlike listTeamJobs/getTeamReviewActivity', async () => {
      // findFirst is scoped to teamRole: 'TEAM_LEADER' only -- a VIEWER's
      // own membership row never matches it, so this resolves null exactly
      // like "no team at all" above.
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce(null);

      const res = makeRes();
      await jobController.listTeamExecutives(makeReq({ user: { id: 'viewer-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect((next as any).mock.calls[0][0].code).toBe('NOT_TEAM_LEADER');
    });

    it('returns every Executive across every team this caller leads, with team name attached', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce({ teamId: 'team-1' });
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }, { teamId: 'team-2' }]) // getLedExecutives' own ledTeams lookup
        .mockResolvedValueOnce([
          { teamId: 'team-1', team: { name: 'Cell A' }, user: { id: 'exec-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } },
          { teamId: 'team-2', team: { name: 'Cell B' }, user: { id: 'exec-2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' } },
        ]);

      const res = makeRes();
      await jobController.listTeamExecutives(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).not.toHaveBeenCalled();
      const executives = (res.json as any).mock.calls[0][0].data.executives;
      expect(executives).toEqual([
        { userId: 'exec-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', teamId: 'team-1', teamName: 'Cell A' },
        { userId: 'exec-2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', teamId: 'team-2', teamName: 'Cell B' },
      ]);
    });
  });

  describe('getTeamReviewActivity() -- GET /jobs/team/review-activity (RBAC Phase 5 self-service reports)', () => {
    it('rejects a caller with no qualifying team membership', async () => {
      (prisma.teamMembership.findMany as any).mockResolvedValueOnce([]);

      const res = makeRes();
      await jobController.getTeamReviewActivity(makeReq({ user: { id: 'exec-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = (next as any).mock.calls[0][0];
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('NOT_TEAM_LEADER_OR_VIEWER');
      expect(teamActivityReportService.getReport).not.toHaveBeenCalled();
    });

    it('resolves the caller\'s team roster and delegates to teamActivityReportService with it', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }, { userId: 'member-2' }]);
      (teamActivityReportService.getReport as any).mockResolvedValue({ period: {}, reviewThroughput: [], ownership: [] });

      const res = makeRes();
      await jobController.getTeamReviewActivity(makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' } } as any), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(teamActivityReportService.getReport).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', memberUserIds: ['leader-1', 'member-2'] })
      );
      expect((res.json as any).mock.calls[0][0].success).toBe(true);
    });

    it('rejects an invalid date range (from after to) with a 400', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }])
        .mockResolvedValueOnce([{ userId: 'leader-1' }]);

      const res = makeRes();
      await jobController.getTeamReviewActivity(
        makeReq({ user: { id: 'leader-1', tenantId: 'tenant-1' }, query: { from: '2026-10-10', to: '2026-10-01' } } as any),
        res,
        next
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect((next as any).mock.calls[0][0].statusCode).toBe(400);
      expect(teamActivityReportService.getReport).not.toHaveBeenCalled();
    });
  });
});
