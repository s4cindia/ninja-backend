/**
 * upload.controller.ts -- presigned-S3 upload flow (presign -> client PUT ->
 * confirm). Covers the PDF-aware size cap and the confirmUpload real-size
 * verification added for batch PDF processing (comparison-study batch weight
 * tiering depends on File.size being honest, not just client-declared).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    file: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../src/services/s3.service', () => ({
  s3Service: { getPresignedUploadUrl: vi.fn(), getFileSize: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { s3Service } from '../../../src/services/s3.service';
import { getPresignedUploadUrl, confirmUpload } from '../../../src/controllers/upload.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    params: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as Request;
}

describe('upload.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(s3Service.getPresignedUploadUrl).mockResolvedValue({
      uploadUrl: 'https://s3.example/put', fileKey: 'tenant-1/some.pdf', expiresIn: 900,
    } as any);
    vi.mocked(prisma.file.create).mockResolvedValue({ id: 'file-1' } as any);
  });

  describe('getPresignedUploadUrl', () => {
    it('allows a PDF larger than 100MB, up to pdfConfig.maxFileSizeMB (2000MB default)', async () => {
      const req = makeReq({ body: { fileName: 'large.pdf', fileSize: 500 * 1024 * 1024 } });
      const res = makeRes();

      await getPresignedUploadUrl(req, res);

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('rejects a PDF over pdfConfig.maxFileSizeMB', async () => {
      const req = makeReq({ body: { fileName: 'huge.pdf', fileSize: 2001 * 1024 * 1024 } });
      const res = makeRes();

      await getPresignedUploadUrl(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.file.create).not.toHaveBeenCalled();
    });

    it('keeps the original 100MB cap for a non-PDF (EPUB) file -- unrelated to the PDF-specific change', async () => {
      const req = makeReq({ body: { fileName: 'book.epub', fileSize: 150 * 1024 * 1024 } });
      const res = makeRes();

      await getPresignedUploadUrl(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('100MB'),
      }));
    });
  });

  describe('confirmUpload', () => {
    it("overwrites the client-declared size with the real S3 size from a HEAD request, and marks the file UPLOADED", async () => {
      // Real risk this closes: batch weight tiering (comparison-study PDF
      // batch processing) depends on File.size being honest -- nothing
      // before this point verified the client-declared fileSize (from
      // getPresignedUploadUrl) matches what actually landed in S3.
      vi.mocked(prisma.file.findFirst).mockResolvedValue({
        id: 'file-1', status: 'PENDING_UPLOAD', storagePath: 'tenant-1/some.pdf', path: 'tenant-1/some.pdf', size: 999,
      } as any);
      vi.mocked(s3Service.getFileSize).mockResolvedValue(123456789);
      vi.mocked(prisma.file.update).mockResolvedValue({ id: 'file-1', status: 'UPLOADED', size: 123456789 } as any);

      const req = makeReq({ params: { fileId: 'file-1' } });
      const res = makeRes();

      await confirmUpload(req, res);

      expect(s3Service.getFileSize).toHaveBeenCalledWith('tenant-1/some.pdf');
      expect(prisma.file.update).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        data: { status: 'UPLOADED', size: 123456789 },
      });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('returns 400 (not a raw S3 error) instead of confirming when the object never actually landed in S3', async () => {
      vi.mocked(prisma.file.findFirst).mockResolvedValue({
        id: 'file-1', status: 'PENDING_UPLOAD', storagePath: 'tenant-1/some.pdf', path: 'tenant-1/some.pdf',
      } as any);
      vi.mocked(s3Service.getFileSize).mockRejectedValue(new Error('NotFound'));

      const req = makeReq({ params: { fileId: 'file-1' } });
      const res = makeRes();

      await confirmUpload(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.file.update).not.toHaveBeenCalled();
    });
  });
});
