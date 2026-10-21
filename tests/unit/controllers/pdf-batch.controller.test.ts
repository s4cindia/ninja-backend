/**
 * PdfBatchController -- CRUD + lifecycle for PdfBatch/PdfBatchItem. Items
 * reference an already-confirmed File row by id (no multipart upload here),
 * and startBatch dispatches one BullMQ job per item (see
 * batch.controller.ts's dispatchBatchProcessing / pdf-auto-mode.controller
 * .ts's enqueueOrRunAutoLoop for the precedent this mirrors).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

const mockPdfBatchCreate = vi.fn();
const mockPdfBatchFindFirst = vi.fn();
const mockPdfBatchUpdate = vi.fn();
const mockPdfBatchFindMany = vi.fn();
const mockPdfBatchCount = vi.fn();
const mockPdfBatchItemCreate = vi.fn();
const mockPdfBatchItemFindFirst = vi.fn();
const mockPdfBatchItemDelete = vi.fn();
const mockPdfBatchItemUpdateMany = vi.fn();
const mockPdfBatchItemGroupBy = vi.fn();
const mockFileFindFirst = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    pdfBatch: {
      create: (...args: unknown[]) => mockPdfBatchCreate(...args),
      findFirst: (...args: unknown[]) => mockPdfBatchFindFirst(...args),
      update: (...args: unknown[]) => mockPdfBatchUpdate(...args),
      findMany: (...args: unknown[]) => mockPdfBatchFindMany(...args),
      count: (...args: unknown[]) => mockPdfBatchCount(...args),
    },
    pdfBatchItem: {
      create: (...args: unknown[]) => mockPdfBatchItemCreate(...args),
      findFirst: (...args: unknown[]) => mockPdfBatchItemFindFirst(...args),
      delete: (...args: unknown[]) => mockPdfBatchItemDelete(...args),
      updateMany: (...args: unknown[]) => mockPdfBatchItemUpdateMany(...args),
      groupBy: (...args: unknown[]) => mockPdfBatchItemGroupBy(...args),
    },
    file: {
      findFirst: (...args: unknown[]) => mockFileFindFirst(...args),
    },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockQueueAdd = vi.fn();
const mockAreQueuesAvailable = vi.fn();
const mockGetPdfBatchItemQueue = vi.fn();
vi.mock('../../../src/queues', () => ({
  areQueuesAvailable: () => mockAreQueuesAvailable(),
  getPdfBatchItemQueue: () => mockGetPdfBatchItemQueue(),
}));

const mockProcessItem = vi.fn();
vi.mock('../../../src/services/pdf-batch/pdf-batch-orchestrator.service', () => ({
  pdfBatchOrchestratorService: { processItem: (...args: unknown[]) => mockProcessItem(...args) },
}));

vi.mock('../../../src/services/pdf-batch/concurrency-budget.service', () => ({
  computeSizeWeight: vi.fn(() => 1),
}));

const mockComputeRemediationCounts = vi.fn();
vi.mock('../../../src/services/pdf/remediation-cycle-history.service', () => ({
  computeRemediationCounts: (...args: unknown[]) => mockComputeRemediationCounts(...args),
}));

import { pdfBatchController } from '../../../src/controllers/pdf-batch.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    body: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  };
}

describe('PdfBatchController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAreQueuesAvailable.mockReturnValue(true);
    mockGetPdfBatchItemQueue.mockReturnValue({ add: mockQueueAdd } as any);
    mockQueueAdd.mockResolvedValue(undefined);
    mockProcessItem.mockResolvedValue(undefined);
  });

  describe('createBatch', () => {
    it('creates a DRAFT batch scoped to the caller', async () => {
      mockPdfBatchCreate.mockResolvedValue({ id: 'batch-1', name: 'My Batch', status: 'DRAFT', totalFiles: 0, createdAt: new Date() });
      const res = makeRes();

      await pdfBatchController.createBatch(makeReq({ body: { name: 'My Batch' } }), res);

      expect(mockPdfBatchCreate).toHaveBeenCalledWith({ data: { tenantId: 'tenant-1', userId: 'user-1', name: 'My Batch' } });
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('addItems', () => {
    const draftBatch = { id: 'batch-1', tenantId: 'tenant-1', status: 'DRAFT' };

    it('rejects a sourceFileId that is not found or not yet confirmed', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(draftBatch);
      mockFileFindFirst.mockResolvedValue(null);
      const res = makeRes();

      await pdfBatchController.addItems(makeReq({ params: { batchId: 'batch-1' }, body: { items: [{ sourceFileId: 'file-x' }] } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockPdfBatchItemCreate).not.toHaveBeenCalled();
    });

    it('rejects a non-PDF file', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(draftBatch);
      mockFileFindFirst.mockResolvedValue({ id: 'file-1', mimeType: 'application/epub+zip', filename: 'book.epub', originalName: 'book.epub', size: 100 });
      const res = makeRes();

      await pdfBatchController.addItems(makeReq({ params: { batchId: 'batch-1' }, body: { items: [{ sourceFileId: 'file-1' }] } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPdfBatchItemCreate).not.toHaveBeenCalled();
    });

    it('creates an item from a confirmed PDF file and increments totalFiles', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(draftBatch);
      mockFileFindFirst.mockResolvedValue({
        id: 'file-1', mimeType: 'application/pdf', filename: 'book-123.pdf', originalName: 'book.pdf',
        size: 2048, storagePath: 'job-storage/file-1/book-123.pdf', path: null,
      });
      mockPdfBatchItemCreate.mockResolvedValue({ id: 'item-1', fileName: 'book-123.pdf', originalName: 'book.pdf', fileSize: BigInt(2048), status: 'UPLOADED' });
      const res = makeRes();

      await pdfBatchController.addItems(makeReq({ params: { batchId: 'batch-1' }, body: { items: [{ sourceFileId: 'file-1' }] } }), res);

      expect(mockPdfBatchItemCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ batchId: 'batch-1', sourceFileId: 'file-1', sizeWeightUnits: 1, status: 'UPLOADED' }),
      });
      expect(mockPdfBatchUpdate).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { totalFiles: { increment: 1 } } });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('refuses to add items to a non-DRAFT batch', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({ ...draftBatch, status: 'PROCESSING' });
      const res = makeRes();

      await pdfBatchController.addItems(makeReq({ params: { batchId: 'batch-1' }, body: { items: [{ sourceFileId: 'file-1' }] } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockFileFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('startBatch', () => {
    const draftBatchWithItems = {
      id: 'batch-1', tenantId: 'tenant-1', status: 'DRAFT', totalFiles: 2,
      items: [{ id: 'item-1' }, { id: 'item-2' }],
    };

    it('enqueues one job per item when queues are available', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(draftBatchWithItems);
      mockPdfBatchUpdate.mockResolvedValue({ id: 'batch-1', status: 'QUEUED', totalFiles: 2, startedAt: new Date() });
      const res = makeRes();

      await pdfBatchController.startBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockPdfBatchUpdate).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { status: 'QUEUED', startedAt: expect.any(Date) } });
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'pdf-batch-item-item-1',
        { batchId: 'batch-1', itemId: 'item-1' },
        { jobId: expect.stringMatching(/^item-1-\d+$/) }
      );
      expect(mockProcessItem).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('falls back to in-process dispatch per item when queues are unavailable', async () => {
      mockAreQueuesAvailable.mockReturnValue(false);
      mockPdfBatchFindFirst.mockResolvedValue(draftBatchWithItems);
      mockPdfBatchUpdate.mockResolvedValue({ id: 'batch-1', status: 'QUEUED', totalFiles: 2, startedAt: new Date() });
      const res = makeRes();

      await pdfBatchController.startBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockProcessItem).toHaveBeenCalledWith('batch-1', 'item-1');
      expect(mockProcessItem).toHaveBeenCalledWith('batch-1', 'item-2');
    });

    it('refuses to start an empty batch', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({ ...draftBatchWithItems, totalFiles: 0, items: [] });
      const res = makeRes();

      await pdfBatchController.startBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPdfBatchUpdate).not.toHaveBeenCalled();
    });

    it('persists Auto Mode overrides onto the batch row when provided -- applied uniformly to every item later via the orchestrator, not stored per-item here', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(draftBatchWithItems);
      mockPdfBatchUpdate.mockResolvedValue({ id: 'batch-1', status: 'QUEUED', totalFiles: 2, startedAt: new Date() });
      const res = makeRes();

      await pdfBatchController.startBatch(
        makeReq({
          params: { batchId: 'batch-1' },
          body: { autoMaxRounds: 3, autoCostLimitUsd: 0.5, autoColorContrastMode: 'disabled' },
        }),
        res
      );

      expect(mockPdfBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: {
          status: 'QUEUED',
          startedAt: expect.any(Date),
          autoMaxRounds: 3,
          autoCostLimitUsd: 0.5,
          autoColorContrastMode: 'disabled',
        },
      });
    });
  });

  describe('cancelBatch', () => {
    it('marks a PROCESSING batch CANCELLED and skips not-yet-started items', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({ id: 'batch-1', tenantId: 'tenant-1', status: 'PROCESSING' });
      const res = makeRes();

      await pdfBatchController.cancelBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockPdfBatchUpdate).toHaveBeenCalledWith({ where: { id: 'batch-1' }, data: { status: 'CANCELLED', completedAt: expect.any(Date) } });
      expect(mockPdfBatchItemUpdateMany).toHaveBeenCalledWith({ where: { batchId: 'batch-1', status: 'UPLOADED' }, data: { status: 'SKIPPED' } });
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('refuses to cancel a DRAFT or already-terminal batch', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({ id: 'batch-1', tenantId: 'tenant-1', status: 'COMPLETED' });
      const res = makeRes();

      await pdfBatchController.cancelBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPdfBatchUpdate).not.toHaveBeenCalled();
    });
  });

  describe('getBatch', () => {
    it('returns the batch with per-status counts computed via groupBy, not stored counters', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({
        id: 'batch-1', name: 'B', status: 'PROCESSING', totalFiles: 2, createdAt: new Date(), startedAt: new Date(), completedAt: null,
        items: [
          { id: 'item-1', fileName: 'a.pdf', originalName: 'a.pdf', fileSize: BigInt(10), status: 'AUDITED', auditScore: 90, issuesFound: 3, pageCount: 5, issuesAutoFixed: null, issuesGuidanceOnly: null, remediatedFilePath: null, error: null, uploadedAt: new Date(), auditJobId: 'job-1', auditStartedAt: new Date('2026-10-18T00:00:00Z'), auditCompletedAt: new Date(), remediationStartedAt: null, remediationCompletedAt: null },
        ],
      });
      mockPdfBatchItemGroupBy.mockResolvedValue([{ status: 'AUDITED', _count: { status: 1 } }]);
      const res = makeRes();

      await pdfBatchController.getBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockPdfBatchItemGroupBy).toHaveBeenCalledWith({ by: ['status'], where: { batchId: 'batch-1' }, _count: { status: true } });
      const payload = (res.json as any).mock.calls[0][0];
      expect(payload.data.statusCounts).toEqual({ AUDITED: 1 });
      expect(payload.data.items[0].fileSize).toBe('10'); // BigInt serialized to string
      // Real bug (2026-10-18): these three were on the Prisma row (written by
      // the orchestrator since PR #678) but never actually included in this
      // response -- PdfBatchItemElapsed's ticker and PdfBatchResultsList's
      // download button both silently depended on fields that were always
      // undefined.
      expect(payload.data.items[0].auditJobId).toBe('job-1');
      expect(payload.data.items[0].auditStartedAt).toEqual(new Date('2026-10-18T00:00:00Z'));
      expect(payload.data.items[0].remediationStartedAt).toBeNull();
    });

    it('returns 404 for a batch the caller does not own', async () => {
      mockPdfBatchFindFirst.mockResolvedValue(null);
      const res = makeRes();

      await pdfBatchController.getBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    /**
     * Real gap (2026-10-21): pdf-batch-orchestrator.service.ts writes
     * issuesAutoFixed/issuesGuidanceOnly onto PdfBatchItem exactly once,
     * when its own runRemediationPhase call returns -- including on a
     * budget_limit stop. A job can keep genuinely improving afterward via
     * POST /pdf/:jobId/auto-mode/start (confirmed live on
     * Math_Olszewski_PDF.pdf), but nothing re-invokes runRemediationPhase,
     * so the stored snapshot goes stale while the job keeps moving. This
     * endpoint now recomputes live from the same source of truth instead.
     */
    it('overrides issuesAutoFixed/issuesGuidanceOnly with live counts when remediation was started -- the job-level-resume regression', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({
        id: 'batch-1', name: 'B', status: 'PROCESSING', totalFiles: 1, createdAt: new Date(), startedAt: new Date(), completedAt: null,
        items: [
          {
            id: 'item-1', fileName: 'a.pdf', originalName: 'a.pdf', fileSize: BigInt(10), status: 'REMEDIATED',
            auditScore: 49, issuesFound: 1812, pageCount: 414,
            // Stale snapshot from the FIRST stop (budget_limit) -- lower
            // than what the job-level resume has since achieved.
            issuesAutoFixed: 1323, issuesGuidanceOnly: 489,
            remediatedFilePath: 's3://remediated/a.pdf', error: null, uploadedAt: new Date(),
            auditJobId: 'job-1', auditStartedAt: new Date(), auditCompletedAt: new Date(),
            remediationStartedAt: new Date(), remediationCompletedAt: new Date(),
          },
        ],
      });
      mockPdfBatchItemGroupBy.mockResolvedValue([{ status: 'REMEDIATED', _count: { status: 1 } }]);
      // The live computation (round 2+, after a job-level resume) reflects
      // more real progress than the stale stored snapshot above.
      mockComputeRemediationCounts.mockResolvedValue({ issuesAutoFixed: 1600, issuesGuidanceOnly: 212 });
      const res = makeRes();

      await pdfBatchController.getBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockComputeRemediationCounts).toHaveBeenCalledWith('job-1', 1812);
      const payload = (res.json as any).mock.calls[0][0];
      expect(payload.data.items[0].issuesAutoFixed).toBe(1600);
      expect(payload.data.items[0].issuesGuidanceOnly).toBe(212);
      // status and remediatedFilePath are NOT live-recomputed -- deliberately
      // out of scope (status is the batch pipeline's own state machine;
      // remediatedFilePath is a deterministic storage key, still correct).
      expect(payload.data.items[0].status).toBe('REMEDIATED');
      expect(payload.data.items[0].remediatedFilePath).toBe('s3://remediated/a.pdf');
    });

    it('does not call computeRemediationCounts for an item that never reached remediation -- no added cost for the common case', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({
        id: 'batch-1', name: 'B', status: 'PROCESSING', totalFiles: 1, createdAt: new Date(), startedAt: new Date(), completedAt: null,
        items: [
          { id: 'item-1', fileName: 'a.pdf', originalName: 'a.pdf', fileSize: BigInt(10), status: 'AUDITED', auditScore: 90, issuesFound: 3, pageCount: 5, issuesAutoFixed: null, issuesGuidanceOnly: null, remediatedFilePath: null, error: null, uploadedAt: new Date(), auditJobId: 'job-1', auditStartedAt: new Date(), auditCompletedAt: new Date(), remediationStartedAt: null, remediationCompletedAt: null },
        ],
      });
      mockPdfBatchItemGroupBy.mockResolvedValue([{ status: 'AUDITED', _count: { status: 1 } }]);
      const res = makeRes();

      await pdfBatchController.getBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockComputeRemediationCounts).not.toHaveBeenCalled();
      const payload = (res.json as any).mock.calls[0][0];
      expect(payload.data.items[0].issuesAutoFixed).toBeNull();
      expect(payload.data.items[0].issuesGuidanceOnly).toBeNull();
    });

    it('falls back to the stored values when the live computation returns null (remediation started but no reaudit completed yet)', async () => {
      mockPdfBatchFindFirst.mockResolvedValue({
        id: 'batch-1', name: 'B', status: 'PROCESSING', totalFiles: 1, createdAt: new Date(), startedAt: new Date(), completedAt: null,
        items: [
          { id: 'item-1', fileName: 'a.pdf', originalName: 'a.pdf', fileSize: BigInt(10), status: 'REMEDIATING', auditScore: 49, issuesFound: 1812, pageCount: 414, issuesAutoFixed: null, issuesGuidanceOnly: null, remediatedFilePath: null, error: null, uploadedAt: new Date(), auditJobId: 'job-1', auditStartedAt: new Date(), auditCompletedAt: new Date(), remediationStartedAt: new Date(), remediationCompletedAt: null },
        ],
      });
      mockPdfBatchItemGroupBy.mockResolvedValue([{ status: 'REMEDIATING', _count: { status: 1 } }]);
      mockComputeRemediationCounts.mockResolvedValue(null);
      const res = makeRes();

      await pdfBatchController.getBatch(makeReq({ params: { batchId: 'batch-1' } }), res);

      expect(mockComputeRemediationCounts).toHaveBeenCalledWith('job-1', 1812);
      const payload = (res.json as any).mock.calls[0][0];
      expect(payload.data.items[0].issuesAutoFixed).toBeNull();
      expect(payload.data.items[0].issuesGuidanceOnly).toBeNull();
    });
  });
});
