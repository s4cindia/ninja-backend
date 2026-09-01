/**
 * PdfAiAnalysisController.updateStatus -- covers the value-editing addition
 * only (letting an operator override an AI-drafted suggestion's value
 * before approving it, e.g. for the Tier 1 link-text/form-field-label/
 * bookmark-title manual-fix writers). This controller otherwise has no
 * existing unit test coverage; not attempting to backfill the rest here.
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

function makeReq(body: Record<string, unknown>): Request {
  return {
    params: { issueId: 'issue-1' },
    body,
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1' },
  } as unknown as Request;
}

describe('PdfAiAnalysisController.updateStatus', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
      jobId: 'job-1',
      issueId: 'issue-1',
      status: 'pending',
      value: 'AI-drafted text',
      approvedBy: null,
    } as any);
    vi.mocked(prisma.aiAnalysis.update).mockResolvedValue({} as any);
  });

  it('persists an operator-edited value alongside approval', async () => {
    const res = makeRes();

    await pdfAiAnalysisController.updateStatus(
      makeReq({ status: 'approved', value: 'Operator-edited text' }),
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(prisma.aiAnalysis.update).toHaveBeenCalledWith({
      where: { jobId_issueId: { jobId: 'job-1', issueId: 'issue-1' } },
      data: {
        status: 'approved',
        approvedBy: 'operator',
        value: 'Operator-edited text',
        updatedAt: expect.any(Date),
      },
    });
  });

  it('leaves value untouched when not provided', async () => {
    const res = makeRes();

    await pdfAiAnalysisController.updateStatus(makeReq({ status: 'approved' }), res, next);

    expect(next).not.toHaveBeenCalled();
    const call = vi.mocked(prisma.aiAnalysis.update).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('value');
  });

  it('rejects an empty-string value', async () => {
    const res = makeRes();

    await pdfAiAnalysisController.updateStatus(makeReq({ status: 'approved', value: '' }), res, next);

    expect(prisma.aiAnalysis.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});
