/**
 * PdfRemediationController.reauditFromFile (+ reauditPdf's shared behavior)
 *
 * reauditPdf (POST .../remediation/re-audit, "Upload Fixed PDF" in the UI)
 * accepts a direct multipart body through this service's own CloudFront
 * distribution -- which has AWSManagedRulesCommonRuleSet actively enforced,
 * the same WAF this codebase's main PDF upload was already migrated off of
 * (CLAUDE.md's "WAF Blocking File Uploads"). Confirmed live, 2026-11-05: a
 * 15MB "Upload Fixed PDF" attempt produced a browser "Network Error" and
 * left zero trace in this service's own logs across two attempts -- the
 * request never reached the Express app.
 *
 * reauditFromFile (POST .../remediation/re-audit-from-file) is the fix:
 * takes a fileId from the generic presigned-S3 upload flow (POST
 * /files/presign -> PUT directly to S3 -> POST /files/:fileId/confirm)
 * instead of a multipart body, so the large binary never transits this
 * service's own CloudFront distribution at all. Both routes share
 * everything downstream of "we have real PDF bytes" via the private
 * runReauditCycle -- these tests cover reauditFromFile's own
 * fileId/File-row validation, plus smoke coverage confirming reauditPdf's
 * externally-visible behavior is unchanged after the extraction.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { pdfRemediationController } from '../../../src/controllers/pdf-remediation.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { pdfReauditService } from '../../../src/services/pdf/pdf-reaudit.service';
import { s3Service } from '../../../src/services/s3.service';
import { ReauditComparisonResult } from '../../../src/types/pdf-reaudit.types';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    file: { findFirst: vi.fn() },
    remediationCycleEvent: { create: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../../../src/services/storage/file-storage.service');
vi.mock('../../../src/services/pdf/pdf-reaudit.service');
vi.mock('../../../src/services/s3.service', () => ({
  // isConfigured: file-storage.service.ts (transitively imported) calls
  // this at module load time, before any test body runs -- without it,
  // importing the controller under test throws before a single test can.
  s3Service: { getFileBuffer: vi.fn(), isConfigured: vi.fn().mockReturnValue(true) },
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

function makeReq(overrides: Partial<AuthenticatedRequest> & { body?: unknown } = {}): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    body: { fileId: 'file-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function emptyMetrics(): ReauditComparisonResult['metrics'] {
  return {
    totalOriginal: 0, totalNew: 0, resolvedCount: 0, remainingCount: 0, regressionCount: 0, resolutionRate: 0,
    criticalResolved: 0, criticalRemaining: 0,
    severityBreakdown: {
      critical: { resolved: 0, remaining: 0 }, serious: { resolved: 0, remaining: 0 },
      moderate: { resolved: 0, remaining: 0 }, minor: { resolved: 0, remaining: 0 },
    },
  };
}

function mockLockAcquired(output: Record<string, unknown> = {}) {
  vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.job.findUnique).mockResolvedValue({
    id: 'job-1',
    output,
    remediationCycleCounter: 1,
    remediationCycleLockedAt: new Date(),
    remediationCycleLockedBy: 'user-1',
    remediationCycleSource: 'reaudit_pdf_upload',
  } as any);
  vi.mocked(prisma.remediationCycleEvent.create).mockResolvedValue({} as any);
}

const PDF_BYTES = Buffer.from('%PDF-1.7\nfake pdf content');
const NOT_PDF_BYTES = Buffer.from('not a pdf at all');

function mockUploadedFile(overrides: Record<string, unknown> = {}) {
  vi.mocked(prisma.file.findFirst).mockResolvedValue({
    id: 'file-1',
    tenantId: 'tenant-1',
    originalName: 'manually-fixed.pdf',
    mimeType: 'application/pdf',
    size: PDF_BYTES.length,
    status: 'UPLOADED',
    storagePath: 'tenant-1/file-1/manually-fixed.pdf',
    ...overrides,
  } as any);
}

describe('PdfRemediationController.reauditFromFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq({ user: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when fileId is missing from the body', async () => {
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    }));
  });

  it('returns 404 when the job does not exist (or belongs to another tenant)', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 for a non-PDF job', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'EPUB_ACCESSIBILITY', input: {}, output: {} } as any);
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_JOB_TYPE' }),
    }));
  });

  it('returns 400 when the fileId does not resolve to any file for this tenant', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    vi.mocked(prisma.file.findFirst).mockResolvedValue(null as any);
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_FILE' }),
    }));
    expect(s3Service.getFileBuffer).not.toHaveBeenCalled();
  });

  it("returns 400 when the file's upload was never confirmed (still PENDING_UPLOAD)", async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    mockUploadedFile({ status: 'PENDING_UPLOAD' });
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(s3Service.getFileBuffer).not.toHaveBeenCalled();
  });

  it('returns 413 when the uploaded file exceeds the 100MB cap', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    mockUploadedFile({ size: 200 * 1024 * 1024 });
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(s3Service.getFileBuffer).not.toHaveBeenCalled();
  });

  it('returns 400 when the fetched S3 bytes do not start with the PDF magic bytes', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    mockUploadedFile();
    vi.mocked(s3Service.getFileBuffer).mockResolvedValue(NOT_PDF_BYTES);
    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_PDF' }),
    }));
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
  });

  it('returns 409 when a remediation cycle is already in progress for this job', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    mockUploadedFile();
    vi.mocked(s3Service.getFileBuffer).mockResolvedValue(PDF_BYTES);
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      remediationCycleLockedAt: new Date(),
      remediationCycleLockedBy: 'other-user',
      remediationCycleSource: 'apply_all',
    } as any);

    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
  });

  it('fetches the real bytes from S3 by storagePath and runs the same comparison reauditPdf would, on success', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'original-canonical-name.pdf' }, output: {},
    } as any);
    mockUploadedFile();
    vi.mocked(s3Service.getFileBuffer).mockResolvedValue(PDF_BYTES);
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true, jobId: 'job-1', originalAuditId: 'job-1', reauditId: 'job-1-reaudit', fileName: 'manually-fixed.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
    });
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://.../original-canonical-name.pdf');
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);

    expect(s3Service.getFileBuffer).toHaveBeenCalledWith('tenant-1/file-1/manually-fixed.pdf');
    // reauditAndCompare runs against the fetched S3 bytes, using the File
    // row's own originalName -- not the eventual canonical save name.
    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledWith('job-1', PDF_BYTES, 'manually-fixed.pdf');
    // The result is saved back under the JOB's canonical fileName (same
    // reachability rule reauditPdf already follows), not the upload's own.
    expect(fileStorageService.saveRemediatedFile).toHaveBeenCalledWith('job-1', 'original-canonical-name.pdf', PDF_BYTES);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('releases the lock and logs a failed event when the re-audit throws, same as reauditPdf', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    mockUploadedFile();
    vi.mocked(s3Service.getFileBuffer).mockResolvedValue(PDF_BYTES);
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockRejectedValue(new Error('boom'));

    const res = makeRes();
    await pdfRemediationController.reauditFromFile(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(prisma.job.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', remediationCycleCounter: 1 },
      data: expect.objectContaining({ remediationCycleLockedAt: null }),
    }));
    expect(prisma.remediationCycleEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'reaudit', status: 'failed', errorMessage: 'boom' }),
    }));
  });
});

describe('PdfRemediationController.reauditPdf (unchanged after extracting runReauditCycle)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMultipartReq(overrides: Record<string, unknown> = {}) {
    return {
      params: { jobId: 'job-1' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      file: { buffer: PDF_BYTES, originalname: 'manually-fixed.pdf', size: PDF_BYTES.length, mimetype: 'application/pdf' },
      ...overrides,
    } as unknown as AuthenticatedRequest;
  }

  it('returns 400 when no file is attached', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    const res = makeRes();
    await pdfRemediationController.reauditPdf(makeMultipartReq({ file: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_FILE' }),
    }));
  });

  it('returns 400 for invalid PDF magic bytes', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: {}, output: {} } as any);
    const res = makeRes();
    await pdfRemediationController.reauditPdf(makeMultipartReq({ file: { buffer: NOT_PDF_BYTES, originalname: 'x.pdf', size: NOT_PDF_BYTES.length } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_PDF' }),
    }));
  });

  it('still completes a full successful cycle end to end through the shared runReauditCycle', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {},
    } as any);
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true, jobId: 'job-1', originalAuditId: 'job-1', reauditId: 'job-1-reaudit', fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
    });
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://.../doc.pdf');
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditPdf(makeMultipartReq(), res);

    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledWith('job-1', PDF_BYTES, 'manually-fixed.pdf');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
