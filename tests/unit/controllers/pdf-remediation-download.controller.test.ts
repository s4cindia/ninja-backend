/**
 * PdfRemediationController.downloadRemediatedPdf
 *
 * Regression for a real production bug: the old implementation read raw
 * local disk directly (fs.stat/fs.readFile against EPUB_STORAGE_PATH),
 * treating job.output.remediatedFileUrl as a local filesystem path. But
 * saveRemediatedFile (the writer) goes through fileStorageService, which
 * returns an S3 key like "job-storage/{jobId}/remediated/{fileName}" once
 * S3 storage is configured (PR #482) -- the old reader always misinterpreted
 * that key as a local path relative to EPUB_STORAGE_PATH and always missed
 * (ENOENT), regardless of whether AI fixes were actually applied. The fix
 * routes through fileStorageService.downloadFile/getRemediatedFile instead,
 * the same abstraction the writer already uses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { pdfRemediationController } from '../../../src/controllers/pdf-remediation.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn() },
  },
}));
vi.mock('../../../src/services/storage/file-storage.service');
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  res.send = vi.fn();
  return res as Response;
}

function makeReq(): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
  } as unknown as AuthenticatedRequest;
}

describe('PdfRemediationController.downloadRemediatedPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads via fileStorageService.downloadFile using the stored remediatedFileUrl (S3 key), not raw local disk', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      type: 'PDF_ACCESSIBILITY',
      input: { fileName: 'math_kim.pdf' },
      output: { remediatedFileUrl: 'job-storage/job-1/remediated/math_kim.pdf' },
    } as any);
    const pdfBytes = Buffer.from('%PDF-1.4 fake remediated bytes');
    vi.mocked(fileStorageService.downloadFile).mockResolvedValue(pdfBytes);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.downloadRemediatedPdf(req, res);

    expect(fileStorageService.downloadFile).toHaveBeenCalledWith('job-storage/job-1/remediated/math_kim.pdf');
    expect(fileStorageService.getRemediatedFile).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(pdfBytes);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('math_kim_remediated.pdf'));
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('falls back to getRemediatedFile (tries both naming conventions) when output has no remediatedFileUrl', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      type: 'PDF_ACCESSIBILITY',
      input: { fileName: 'legacy.pdf' },
      output: {},
    } as any);
    const pdfBytes = Buffer.from('%PDF-1.4 legacy remediated bytes');
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(pdfBytes);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.downloadRemediatedPdf(req, res);

    expect(fileStorageService.getRemediatedFile).toHaveBeenCalledWith('job-1', 'legacy.pdf');
    expect(res.send).toHaveBeenCalledWith(pdfBytes);
  });

  it('returns 404 (not a raw 500) when fileStorageService.downloadFile throws not-found', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      type: 'PDF_ACCESSIBILITY',
      input: { fileName: 'math_kim.pdf' },
      output: { remediatedFileUrl: 'job-storage/job-1/remediated/math_kim.pdf' },
    } as any);
    vi.mocked(fileStorageService.downloadFile).mockRejectedValue(new Error('File not found in S3: job-storage/job-1/remediated/math_kim.pdf'));

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.downloadRemediatedPdf(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'NOT_FOUND' }),
    }));
  });

  it('returns 404 when getRemediatedFile resolves null (no AI fixes actually applied yet)', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      type: 'PDF_ACCESSIBILITY',
      input: { fileName: 'untouched.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();
    await pdfRemediationController.downloadRemediatedPdf(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
