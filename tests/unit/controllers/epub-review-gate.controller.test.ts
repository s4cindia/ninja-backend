/**
 * epub.controller.ts's two shipment endpoints (downloadRemediatedFile,
 * exportRemediated) both gate on the job's most recent TeamReview, the same
 * as pdf-remediation.controller.ts's downloadRemediatedPdf -- TeamReview is
 * job-type-agnostic (see team-review.routes.ts), so an EPUB job a QC
 * flagged NEEDS_CORRECTION must be blocked from shipping too.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { epubController } from '../../../src/controllers/epub.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';
import { epubExportService } from '../../../src/services/epub/epub-export.service';
import { getActiveReviewBlock } from '../../../src/services/team-review/review-gate.service';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn() },
  },
}));
vi.mock('../../../src/services/epub/epub-export.service');
vi.mock('../../../src/services/team-review/review-gate.service');
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

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    query: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

const BLOCK = {
  reviewId: 'r-1',
  reviewedBy: 'leader-1',
  reviewedAt: new Date('2026-11-01'),
  notes: 'retag the heading structure',
};

describe('epub.controller review gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveReviewBlock).mockResolvedValue(null);
  });

  describe('downloadRemediatedFile', () => {
    it('blocks with 403 when the latest TeamReview is NEEDS_CORRECTION, without touching storage', async () => {
      vi.mocked(prisma.job.findFirst).mockResolvedValue({
        id: 'job-1',
        output: { autoRemediation: { remediatedFileName: 'book_remediated.epub' } },
      } as any);
      vi.mocked(getActiveReviewBlock).mockResolvedValue(BLOCK);

      const res = makeRes();
      await epubController.downloadRemediatedFile(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'BLOCKED_NEEDS_CORRECTION' }),
      }));
      expect(res.send).not.toHaveBeenCalled();
    });

    it('proceeds normally when there is no block', async () => {
      vi.mocked(prisma.job.findFirst).mockResolvedValue({
        id: 'job-1',
        output: { autoRemediation: { remediatedFileName: 'book_remediated.epub' } },
      } as any);

      const res = makeRes();
      await epubController.downloadRemediatedFile(makeReq(), res);

      expect(res.status).not.toHaveBeenCalledWith(403);
    });
  });

  describe('exportRemediated', () => {
    it('blocks with 403 before ever calling epubExportService', async () => {
      vi.mocked(getActiveReviewBlock).mockResolvedValue(BLOCK);

      const res = makeRes();
      await epubController.exportRemediated(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'BLOCKED_NEEDS_CORRECTION' }),
      }));
      expect(epubExportService.exportRemediated).not.toHaveBeenCalled();
    });

    it('calls through to epubExportService when there is no block', async () => {
      vi.mocked(epubExportService.exportRemediated).mockResolvedValue({
        buffer: Buffer.from('fake epub'),
        mimeType: 'application/epub+zip',
        fileName: 'book_remediated.epub',
        size: 9,
      } as any);

      const res = makeRes();
      await epubController.exportRemediated(makeReq(), res);

      expect(epubExportService.exportRemediated).toHaveBeenCalledWith('job-1', 'tenant-1', expect.any(Object));
      expect(res.send).toHaveBeenCalled();
    });
  });
});
