/**
 * JobController -- covers the `auditReport` flattening fix for PDF
 * accessibility jobs. Real incident (2026-10-20): both the single-file
 * (accessibility.processor.ts) and batch (pdf-batch-orchestrator.service.ts)
 * PDF audit paths persist `Job.output` as
 * `{ auditReport: AuditReport, fileName, scanLevel, type, ... }` -- the real
 * score/issues live nested under `auditReport`, never flattened to the
 * top-level score/summary/combinedIssues shape the generic Jobs > :jobId
 * detail page (frontend JobDetails.tsx, via parseJobOutput) reads. Every PDF
 * audit job rendered "Score 0 / No detailed issues available" despite having
 * real audit data, confirmed live on a job with a real score of 37 and
 * 11991 issues.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock('../../../src/services/queue.service', () => ({
  queueService: { getJobStatus: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { queueService } from '../../../src/services/queue.service';
import { jobController } from '../../../src/controllers/job.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { id: 'job-1' },
    query: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

const PDF_BATCH_SHAPED_OUTPUT = {
  fileName: 'FMHE_PDF.pdf',
  scanLevel: 'comprehensive',
  type: 'PDF_ACCESSIBILITY',
  dbJobId: 'job-1',
  auditReport: {
    jobId: 'job-1',
    fileName: 'FMHE_PDF.pdf',
    score: 37,
    issues: [
      { id: 'i1', code: 'MATTERHORN-01-001', severity: 'critical', message: 'Missing tag' },
      { id: 'i2', code: 'MATTERHORN-13-001', severity: 'serious', message: 'Missing alt text' },
    ],
    summary: { critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 },
    metadata: { pageCount: 2040 },
  },
};

const ALREADY_FLAT_EPUB_OUTPUT = {
  jobId: 'job-2',
  fileName: 'book.epub',
  score: 85,
  isValid: true,
  isAccessible: true,
  epubVersion: '3.0',
  summary: { critical: 0, serious: 1, moderate: 2, minor: 0, total: 3 },
  combinedIssues: [{ id: 'e1', code: 'epub-type-has-matching-role', severity: 'serious' }],
};

describe('JobController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get() -- GET /jobs/:id (JobDetails.tsx\'s data source)', () => {
    it('flattens a PDF audit job\'s nested auditReport onto the top-level output fields', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-1',
        type: 'PDF_ACCESSIBILITY',
        status: 'COMPLETED',
        output: PDF_BATCH_SHAPED_OUTPUT,
      });

      const res = makeRes();
      await jobController.get(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(37);
      expect(output.summary).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 0, total: 2 });
      expect(output.combinedIssues).toHaveLength(2);
      expect(output.combinedIssues[0]).toEqual(
        expect.objectContaining({ code: 'MATTERHORN-01-001', severity: 'critical' })
      );
      // Preserves the original nested shape too, for PdfAuditResultsPage.tsx
      // and every other consumer that reads output.auditReport directly.
      expect(output.auditReport).toBe(PDF_BATCH_SHAPED_OUTPUT.auditReport);
    });

    it('derives isAccessible using the same score>=70 && zero-critical threshold EPUB audits use', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-1',
        type: 'PDF_ACCESSIBILITY',
        status: 'COMPLETED',
        output: PDF_BATCH_SHAPED_OUTPUT, // score 37, 1 critical issue
      });

      const res = makeRes();
      await jobController.get(makeReq(), res, next);

      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.isAccessible).toBe(false);
      expect(output.isValid).toBe(true);
    });

    it('does not touch an already-flat output shape (EPUB jobs)', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-2',
        type: 'EPUB_ACCESSIBILITY',
        status: 'COMPLETED',
        output: ALREADY_FLAT_EPUB_OUTPUT,
      });

      const res = makeRes();
      await jobController.get(makeReq({ params: { id: 'job-2' } }), res, next);

      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(85);
      expect(output.summary).toEqual({ critical: 0, serious: 1, moderate: 2, minor: 0, total: 3 });
      expect(output.combinedIssues).toEqual(ALREADY_FLAT_EPUB_OUTPUT.combinedIssues);
    });

    it('still defaults a job with no output at all to the zero-value shape instead of throwing', async () => {
      (queueService.getJobStatus as any).mockResolvedValue({
        id: 'job-3',
        type: 'PDF_ACCESSIBILITY',
        status: 'PROCESSING',
        output: null,
      });

      const res = makeRes();
      await jobController.get(makeReq({ params: { id: 'job-3' } }), res, next);

      expect(next).not.toHaveBeenCalled();
      const output = (res.json as any).mock.calls[0][0].data.output;
      expect(output.score).toBe(0);
      expect(output.combinedIssues).toEqual([]);
    });
  });

  describe('list() -- GET /jobs', () => {
    it('also flattens auditReport for PDF jobs returned in the list', async () => {
      (prisma.job.findMany as any).mockResolvedValue([
        { id: 'job-1', type: 'PDF_ACCESSIBILITY', status: 'COMPLETED', output: PDF_BATCH_SHAPED_OUTPUT, editorialDocument: null },
      ]);
      (prisma.job.count as any).mockResolvedValue(1);

      const res = makeRes();
      await jobController.list(makeReq({ params: {} }), res, next);

      const job = (res.json as any).mock.calls[0][0].data.jobs[0];
      expect(job.output.score).toBe(37);
      expect(job.output.combinedIssues).toHaveLength(2);
    });
  });
});
