/**
 * PdfAiAnalysisController.getAnalysis -- covers the hasRemediatedFile
 * addition specifically. Real bug this fixes: the "Download AI-Fixed PDF"
 * button (PdfAuditResultsPage.tsx) gated on
 * `suggestions.some(s => s.status === 'applied')`, but AiAnalysis rows for
 * a resolved issue are intentionally pruned by analyzeJob once a LATER
 * round's re-audit confirms it's gone (correct for that table's own
 * purpose -- not double-counting resolved issues forever). Auto Mode calls
 * analyzeJob at the top of every round, so the very round that confirms a
 * fix worked also erases the last evidence of it -- by the time Auto Mode
 * reaches natural convergence, zero 'applied' rows remain even though the
 * remediated PDF genuinely has every fix applied. hasRemediatedFile checks
 * the remediated file's own presence in storage instead, a signal that
 * survives every round's pruning.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    aiAnalysis: { findMany: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/pdf/remediation-cycle-lock.service', () => ({
  remediationCycleLockService: { getLockStatus: vi.fn() },
}));
vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { remediatedFileExists: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { remediationCycleLockService } from '../../../src/services/pdf/remediation-cycle-lock.service';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { pdfAiAnalysisController } from '../../../src/controllers/pdf-ai-analysis.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(jobOutput: Record<string, unknown> = {}): Request {
  return {
    params: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1', output: { fileName: 'Math_Weir_PDF.pdf', ...jobOutput } },
  } as unknown as Request;
}

describe('PdfAiAnalysisController.getAnalysis — hasRemediatedFile', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([] as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
  });

  it('reports hasRemediatedFile: true even when every AiAnalysis row has been pruned (0 suggestions)', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([] as any);
    vi.mocked(fileStorageService.remediatedFileExists).mockResolvedValue(true);
    const res = makeRes();

    await pdfAiAnalysisController.getAnalysis(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(fileStorageService.remediatedFileExists).toHaveBeenCalledWith('job-1', 'Math_Weir_PDF.pdf');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ suggestions: [], hasRemediatedFile: true }),
    }));
  });

  it('reports hasRemediatedFile: false when no remediated file has ever been produced', async () => {
    vi.mocked(fileStorageService.remediatedFileExists).mockResolvedValue(false);
    const res = makeRes();

    await pdfAiAnalysisController.getAnalysis(makeReq(), res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ hasRemediatedFile: false }),
    }));
  });

  it('falls back to document.pdf when job.output has no fileName', async () => {
    vi.mocked(fileStorageService.remediatedFileExists).mockResolvedValue(false);
    const res = makeRes();
    const req = { params: {}, user: { id: 'u1', tenantId: 't1' }, job: { id: 'job-1', output: {} } } as unknown as Request;

    await pdfAiAnalysisController.getAnalysis(req, res, next);

    expect(fileStorageService.remediatedFileExists).toHaveBeenCalledWith('job-1', 'document.pdf');
  });
});
