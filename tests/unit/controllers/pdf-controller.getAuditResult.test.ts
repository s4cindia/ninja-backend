/**
 * PdfController.getAuditResult -- non-COMPLETED branch
 *
 * Regression for a real production bug: for a FAILED job, this endpoint
 * used to return only { status, message: 'Audit not started' } -- job.error
 * (the actual failure reason, e.g. "PDF file exceeds maximum size of
 * 500MB") was silently dropped, so the frontend could only ever show a
 * generic "Audit failed. Please try again." with nothing to act on
 * (real incident, 2026-09-25).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/lib/prisma', () => ({
  default: {
    teamReview: { findMany: vi.fn() },
  },
}));

import prisma from '../../../src/lib/prisma';
import { pdfController } from '../../../src/controllers/pdf.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(job: Record<string, unknown>, user?: Record<string, unknown>): Request {
  return { job, user } as unknown as Request;
}

describe('PdfController.getAuditResult', () => {
  it('surfaces job.error and uses it as the message for a FAILED job', async () => {
    const req = makeReq({ id: 'job-1', status: 'FAILED', error: 'PDF file exceeds maximum size of 500MB' });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'FAILED',
        message: 'PDF file exceeds maximum size of 500MB',
        error: 'PDF file exceeds maximum size of 500MB',
      },
    });
  });

  it('falls back to a generic message when a FAILED job has no error recorded', async () => {
    const req = makeReq({ id: 'job-1', status: 'FAILED', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'FAILED',
        message: 'Audit failed',
        error: null,
      },
    });
  });

  it('still reports "Audit in progress" for a PROCESSING job, with error: null', async () => {
    const req = makeReq({ id: 'job-1', status: 'PROCESSING', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'PROCESSING',
        message: 'Audit in progress',
        error: null,
      },
    });
  });

  it('still reports "Audit not started" for a QUEUED job', async () => {
    const req = makeReq({ id: 'job-1', status: 'QUEUED', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'QUEUED',
        message: 'Audit not started',
        error: null,
      },
    });
  });

  describe('COMPLETED branch -- isOwner/teamReviews (RBAC frontend follow-up)', () => {
    const baseJob = {
      id: 'job-1',
      status: 'COMPLETED',
      userId: 'owner-1',
      createdAt: new Date('2026-10-01'),
      completedAt: new Date('2026-10-02'),
      input: { fileName: 'doc.pdf' },
      output: { auditReport: { issues: [] } },
    };

    it('reports isOwner: true and includes teamReviews for the owning user', async () => {
      vi.mocked(prisma.teamReview.findMany).mockResolvedValueOnce([
        { id: 'review-1', jobId: 'job-1', outcome: 'OK', reviewer: { id: 'tl-1', firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
      ] as any);
      const req = makeReq(baseJob, { id: 'owner-1' });
      const res = makeRes();

      await pdfController.getAuditResult(req, res);

      const data = (res.json as any).mock.calls[0][0].data;
      expect(data.isOwner).toBe(true);
      expect(data.teamReviews).toHaveLength(1);
      expect(prisma.teamReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { jobId: 'job-1' } })
      );
    });

    it('reports isOwner: false for a Team Leader/Viewer teammate reading someone else\'s job', async () => {
      vi.mocked(prisma.teamReview.findMany).mockResolvedValueOnce([]);
      const req = makeReq(baseJob, { id: 'team-leader-1' });
      const res = makeRes();

      await pdfController.getAuditResult(req, res);

      const data = (res.json as any).mock.calls[0][0].data;
      expect(data.isOwner).toBe(false);
      expect(data.teamReviews).toEqual([]);
    });

    it('reports reviewBlocked: true when the most recent (first) teamReviews row is NEEDS_CORRECTION', async () => {
      vi.mocked(prisma.teamReview.findMany).mockResolvedValueOnce([
        { id: 'review-2', jobId: 'job-1', outcome: 'NEEDS_CORRECTION', reviewer: { id: 'tl-1', firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
        { id: 'review-1', jobId: 'job-1', outcome: 'OK', reviewer: { id: 'tl-1', firstName: 'Tess', lastName: 'Lead', email: 'tl@x.com' } },
      ] as any);
      const req = makeReq(baseJob, { id: 'owner-1' });
      const res = makeRes();

      await pdfController.getAuditResult(req, res);

      const data = (res.json as any).mock.calls[0][0].data;
      expect(data.reviewBlocked).toBe(true);
    });

    it('reports reviewBlocked: false when there are no reviews yet, or the latest is OK', async () => {
      vi.mocked(prisma.teamReview.findMany).mockResolvedValueOnce([]);
      const req = makeReq(baseJob, { id: 'owner-1' });
      const res = makeRes();

      await pdfController.getAuditResult(req, res);

      const data = (res.json as any).mock.calls[0][0].data;
      expect(data.reviewBlocked).toBe(false);
    });

    // QC brief Theme A (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
    // the frontend pairs an AiAnalysis suggestion to its issue purely by
    // issueId, which churns across re-audits -- attaches each issue's own
    // stable fingerprint here so the frontend can pair by fingerprint
    // instead (defense-in-depth on top of the backend's own stale-row
    // clearing).
    it('attaches a stable fingerprint to each issue, matching buildIssueFingerprint\'s own algorithm', async () => {
      vi.mocked(prisma.teamReview.findMany).mockResolvedValueOnce([]);
      const jobWithIssues = {
        ...baseJob,
        output: {
          auditReport: {
            issues: [
              { id: 'bookmark-1', code: 'BOOKMARK-MISSING-FRONT-MATTER', element: undefined, pageNumber: 1 },
              { id: 'alt-7', code: 'MATTERHORN-13-001', element: 'img_p82_0_Im0', pageNumber: 82 },
            ],
          },
        },
      };
      const req = makeReq(jobWithIssues, { id: 'owner-1' });
      const res = makeRes();

      await pdfController.getAuditResult(req, res);

      const data = (res.json as any).mock.calls[0][0].data;
      expect(data.issues).toEqual([
        { id: 'bookmark-1', code: 'BOOKMARK-MISSING-FRONT-MATTER', element: undefined, pageNumber: 1, fingerprint: 'BOOKMARK-MISSING-FRONT-MATTER:1' },
        { id: 'alt-7', code: 'MATTERHORN-13-001', element: 'img_p82_0_Im0', pageNumber: 82, fingerprint: 'MATTERHORN-13-001:img_p82_0_Im0' },
      ]);
    });
  });
});
