/**
 * PdfAiAnalysisController.applySuggestion -- covers only the new behavior
 * added to support a per-issue Retry on an already-'failed' suggestion: a
 * fresh apply attempt that fails again must call aiAnalysisService's
 * recordApplyFailure (incrementing failedAttempts, refreshing
 * lastErrorReason) instead of leaving the row's failure text stale, the
 * same way applyApprovedSuggestions' own bulk path already does. This
 * controller otherwise has no existing unit test coverage; not attempting
 * to backfill the rest here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    aiAnalysis: { findUnique: vi.fn(), update: vi.fn() },
    job: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/pdf/remediation-cycle-lock.service', () => ({
  remediationCycleLockService: {
    acquireLock: vi.fn().mockResolvedValue({ acquired: true, cycleNumber: 1 }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    getRemediatedFile: vi.fn().mockRejectedValue(new Error('no remediated file')),
    getFile: vi.fn().mockResolvedValue(Buffer.from('fake-pdf-bytes')),
    saveRemediatedFile: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/pdf-modifier.service', () => ({
  pdfModifierService: {
    loadPDF: vi.fn().mockResolvedValue({} as any),
    savePDF: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/pdf-structure-writer.service', () => ({
  pdfStructureWriterService: {
    fixHeadingHierarchy: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/ai-analysis.service', () => ({
  aiAnalysisService: {
    recordApplyFailure: vi.fn().mockResolvedValue(undefined),
  },
  CONTRAST_CODES: new Set(),
}));

import prisma from '../../../src/lib/prisma';
import { aiAnalysisService } from '../../../src/services/pdf/ai-analysis.service';
import { pdfStructureWriterService } from '../../../src/services/pdf/pdf-structure-writer.service';
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
    body: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1', output: {} },
  } as unknown as Request;
}

describe('PdfAiAnalysisController.applySuggestion -- retry-on-failure bookkeeping', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
    vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
      jobId: 'job-1',
      issueId: 'issue-1',
      suggestionType: 'heading-fix',
      applyMode: 'apply-to-pdf',
      status: 'failed',
      failedAttempts: 3,
      value: null,
    } as any);
  });

  it('records a fresh failure (refreshing failedAttempts/lastErrorReason) when a retry on an already-failed suggestion fails again', async () => {
    vi.mocked(pdfStructureWriterService.fixHeadingHierarchy).mockReturnValue([
      { issueId: 'issue-1', success: false, before: 'unknown', after: 'unknown', error: 'still ambiguous' },
    ]);
    const res = makeRes();

    await pdfAiAnalysisController.applySuggestion(makeReq(), res, next);

    expect(aiAnalysisService.recordApplyFailure).toHaveBeenCalledWith('job-1', 'issue-1', 3, 'still ambiguous');
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as any).mock.calls[0][0].message).toContain('still ambiguous');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('does not call recordApplyFailure when the retry succeeds', async () => {
    vi.mocked(pdfStructureWriterService.fixHeadingHierarchy).mockReturnValue([
      { issueId: 'issue-1', success: true, before: 'unknown', after: 'fixed', error: undefined },
    ]);
    vi.mocked(prisma.aiAnalysis.update).mockResolvedValue({ status: 'applied' } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', output: {} } as any);
    const res = makeRes();

    await pdfAiAnalysisController.applySuggestion(makeReq(), res, next);

    expect(aiAnalysisService.recordApplyFailure).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });
});
