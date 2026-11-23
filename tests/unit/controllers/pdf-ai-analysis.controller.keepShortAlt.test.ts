/**
 * PdfAiAnalysisController.keepShortAlt (QC brief Theme B3,
 * docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md): the third of three ways
 * a human completes review of a requiresManualReview row -- a deliberate
 * "the auto-applied short alt is good enough" decision, DB-only (nothing
 * to re-apply).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    aiAnalysis: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { pdfAiAnalysisController } from '../../../src/controllers/pdf-ai-analysis.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(): Request {
  return {
    params: { issueId: 'issue-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1' },
  } as unknown as Request;
}

describe('PdfAiAnalysisController.keepShortAlt', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  it('sets manualReviewCompletedAt (DB-only, no PDF re-apply) for a qualifying row', async () => {
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
      jobId: 'job-1',
      issueId: 'issue-1',
      status: 'applied',
      requiresManualReview: true,
      manualReviewCompletedAt: null,
    } as any);
    vi.mocked(prisma.aiAnalysis.update).mockResolvedValue({} as any);
    const res = makeRes();

    await pdfAiAnalysisController.keepShortAlt(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.aiAnalysis.update).toHaveBeenCalledWith({
      where: { jobId_issueId: { jobId: 'job-1', issueId: 'issue-1' } },
      data: { manualReviewCompletedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: {} });
  });

  it('declines with 404 when the row does not exist', async () => {
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue(null);
    const res = makeRes();

    await pdfAiAnalysisController.keepShortAlt(makeReq(), res, next);

    expect(prisma.aiAnalysis.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('declines when the row does not require manual review', async () => {
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
      jobId: 'job-1',
      issueId: 'issue-1',
      status: 'applied',
      requiresManualReview: false,
      manualReviewCompletedAt: null,
    } as any);
    const res = makeRes();

    await pdfAiAnalysisController.keepShortAlt(makeReq(), res, next);

    expect(prisma.aiAnalysis.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('declines when the row\'s manual review is already completed', async () => {
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
      jobId: 'job-1',
      issueId: 'issue-1',
      status: 'applied',
      requiresManualReview: true,
      manualReviewCompletedAt: new Date('2026-11-20T00:00:00Z'),
    } as any);
    const res = makeRes();

    await pdfAiAnalysisController.keepShortAlt(makeReq(), res, next);

    expect(prisma.aiAnalysis.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});
