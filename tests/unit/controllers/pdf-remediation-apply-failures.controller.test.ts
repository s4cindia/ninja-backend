/**
 * PdfRemediationController.getApplyFailureReport
 *
 * GET /api/v1/pdf/:jobId/remediation/apply-failures -- groups a job's
 * permanently-failed AI suggestions (status: 'failed') by
 * (suggestionType, reason), classifying each group via
 * apply-failure-classification so an operator can see WHY a batch of fixes
 * failed without pulling raw JSON by hand. Pivots over
 * AiAnalysis.lastErrorReason directly, so it reflects the job's FULL
 * failure history, not just one capped cycle-event blob.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { pdfRemediationController } from '../../../src/controllers/pdf-remediation.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn() },
    aiAnalysis: { findMany: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe('PdfRemediationController.getApplyFailureReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1' } as any);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = makeRes();
    await pdfRemediationController.getApplyFailureReport(makeReq({ user: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when the job does not exist or belongs to another tenant', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null);
    const res = makeRes();
    await pdfRemediationController.getApplyFailureReport(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns an empty report when nothing has permanently failed', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([]);
    const res = makeRes();

    await pdfRemediationController.getApplyFailureReport(makeReq(), res);

    expect(prisma.aiAnalysis.findMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', status: 'failed' },
      select: { issueId: true, suggestionType: true, lastErrorReason: true },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { totalFailed: 0, groups: [] } })
    );
  });

  it('groups failures by (suggestionType, reason), with a count and the underlying issueIds per group', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'table-row-reattach-fix', lastErrorReason: 'Row already has a /P, but it does not match this row\'s own natural reattachment point -- declining rather than guessing' },
      { issueId: 'issue-2', suggestionType: 'table-row-reattach-fix', lastErrorReason: 'Row already has a /P, but it does not match this row\'s own natural reattachment point -- declining rather than guessing' },
      { issueId: 'issue-3', suggestionType: 'color-contrast-fix', lastErrorReason: 'Fix did not verify even after escalating to #000000 (measured ratio 1.06:1, needs 4.5:1)' },
    ] as any);
    const res = makeRes();

    await pdfRemediationController.getApplyFailureReport(makeReq(), res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.totalFailed).toBe(3);
    expect(payload.data.groups).toHaveLength(2);

    const contrastGroup = payload.data.groups.find((g: any) => g.suggestionType === 'color-contrast-fix');
    expect(contrastGroup).toMatchObject({
      suggestionType: 'color-contrast-fix',
      category: 'needs_investigation',
      count: 1,
      issueIds: ['issue-3'],
    });

    const tableGroup = payload.data.groups.find((g: any) => g.suggestionType === 'table-row-reattach-fix');
    expect(tableGroup).toMatchObject({
      suggestionType: 'table-row-reattach-fix',
      category: 'correctly_skipped',
      count: 2,
      issueIds: ['issue-1', 'issue-2'],
    });
  });

  it('sorts needs_investigation groups before correctly_skipped ones, and by count descending within a category', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'a', lastErrorReason: 'declining rather than guessing -- low count' },
      { issueId: 'issue-2', suggestionType: 'b', lastErrorReason: 'declining rather than guessing -- high count' },
      { issueId: 'issue-3', suggestionType: 'b', lastErrorReason: 'declining rather than guessing -- high count' },
      { issueId: 'issue-4', suggestionType: 'c', lastErrorReason: 'a totally unrecognized failure' },
    ] as any);
    const res = makeRes();

    await pdfRemediationController.getApplyFailureReport(makeReq(), res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.groups.map((g: any) => g.category)).toEqual([
      'needs_investigation', // the unrecognized reason, highest priority
      'correctly_skipped', // count 2 (suggestionType 'b')
      'correctly_skipped', // count 1 (suggestionType 'a')
    ]);
    expect(payload.data.groups[1].count).toBe(2);
    expect(payload.data.groups[2].count).toBe(1);
  });

  it('groups rows with no recorded reason (failed before this column existed) together under a placeholder, instead of dropping them', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', lastErrorReason: null },
      { issueId: 'issue-2', suggestionType: 'alt-text', lastErrorReason: null },
    ] as any);
    const res = makeRes();

    await pdfRemediationController.getApplyFailureReport(makeReq(), res);

    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.data.totalFailed).toBe(2);
    expect(payload.data.groups).toHaveLength(1);
    expect(payload.data.groups[0]).toMatchObject({ count: 2, issueIds: ['issue-1', 'issue-2'] });
    expect(payload.data.groups[0].reason).toMatch(/unknown error/i);
  });

  it('returns 500 and does not throw when the database query fails', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockRejectedValue(new Error('db down'));
    const res = makeRes();

    await pdfRemediationController.getApplyFailureReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
