/**
 * PdfBatchOrchestratorService -- drives a single PdfBatchItem through
 * audit -> remediate (a full Auto Mode loop, see auto-remediation-loop
 * .service.ts), gated by concurrency-budget.service.ts's weighted leases.
 * This is the first real caller of that service's leasing primitives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPdfBatchFindUnique = vi.fn();
const mockPdfBatchUpdateMany = vi.fn();
const mockPdfBatchItemFindUnique = vi.fn();
const mockPdfBatchItemFindUniqueOrThrow = vi.fn();
const mockPdfBatchItemUpdate = vi.fn();
const mockPdfBatchItemUpdateMany = vi.fn();
const mockPdfBatchItemFindMany = vi.fn();
const mockPdfBatchItemCount = vi.fn();
const mockPdfConcurrencyLeaseFindUnique = vi.fn();
const mockJobCreate = vi.fn();
const mockJobUpdate = vi.fn();
const mockJobFindUnique = vi.fn();
const mockAutoRemediationRunUpsert = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    pdfBatch: {
      findUnique: (...args: unknown[]) => mockPdfBatchFindUnique(...args),
      updateMany: (...args: unknown[]) => mockPdfBatchUpdateMany(...args),
    },
    pdfBatchItem: {
      findUnique: (...args: unknown[]) => mockPdfBatchItemFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockPdfBatchItemFindUniqueOrThrow(...args),
      update: (...args: unknown[]) => mockPdfBatchItemUpdate(...args),
      updateMany: (...args: unknown[]) => mockPdfBatchItemUpdateMany(...args),
      findMany: (...args: unknown[]) => mockPdfBatchItemFindMany(...args),
      count: (...args: unknown[]) => mockPdfBatchItemCount(...args),
    },
    pdfConcurrencyLease: {
      findUnique: (...args: unknown[]) => mockPdfConcurrencyLeaseFindUnique(...args),
    },
    job: {
      create: (...args: unknown[]) => mockJobCreate(...args),
      update: (...args: unknown[]) => mockJobUpdate(...args),
      findUnique: (...args: unknown[]) => mockJobFindUnique(...args),
    },
    pdfAutoRemediationRun: {
      upsert: (...args: unknown[]) => mockAutoRemediationRunUpsert(...args),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockDownloadFile = vi.fn();
vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { downloadFile: (...args: unknown[]) => mockDownloadFile(...args) },
}));

const mockRunAuditFromBuffer = vi.fn();
vi.mock('../../../../src/services/pdf/pdf-audit.service', () => ({
  pdfAuditService: { runAuditFromBuffer: (...args: unknown[]) => mockRunAuditFromBuffer(...args) },
}));

const mockStartAutoLoop = vi.fn();
vi.mock('../../../../src/services/pdf/auto-remediation-loop.service', () => {
  class MockJobAutoRemediationDriver {
    constructor(public runId: string) {}
    describe() { return `job-run ${this.runId}`; }
  }
  return {
    autoRemediationLoopService: { startAutoLoop: (...args: unknown[]) => mockStartAutoLoop(...args) },
    JobAutoRemediationDriver: MockJobAutoRemediationDriver,
  };
});

const mockListForJob = vi.fn();
vi.mock('../../../../src/services/pdf/remediation-cycle-history.service', () => ({
  remediationCycleHistoryService: { listForJob: (...args: unknown[]) => mockListForJob(...args) },
}));

const mockWaitForLease = vi.fn();
const mockReleaseLease = vi.fn();
const mockHeartbeatLease = vi.fn();
vi.mock('../../../../src/services/pdf-batch/concurrency-budget.service', () => ({
  concurrencyBudgetService: {
    waitForLease: (...args: unknown[]) => mockWaitForLease(...args),
    releaseLease: (...args: unknown[]) => mockReleaseLease(...args),
    heartbeatLease: (...args: unknown[]) => mockHeartbeatLease(...args),
  },
  computePageWeight: vi.fn(() => 2),
  computeEffectiveWeight: vi.fn((a: number, b: number) => Math.max(a, b)),
}));

import { pdfBatchOrchestratorService } from '../../../../src/services/pdf-batch/pdf-batch-orchestrator.service';

const batch = { id: 'batch-1', tenantId: 'tenant-1', userId: 'user-1', status: 'PROCESSING' };
const draftItem = {
  id: 'item-1', batchId: 'batch-1', fileName: 'book-123.pdf', originalName: 'book.pdf',
  fileSize: BigInt(1024), storagePath: 'job-storage/file-1/book-123.pdf', sizeWeightUnits: 1,
  effectiveWeightUnits: null,
};

describe('PdfBatchOrchestratorService.processItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPdfBatchFindUnique.mockResolvedValue(batch);
    mockPdfBatchItemFindUnique.mockResolvedValue(draftItem);
    mockPdfBatchItemFindUniqueOrThrow.mockResolvedValue({ ...draftItem, effectiveWeightUnits: 2 });
    mockPdfBatchItemUpdate.mockResolvedValue(draftItem);
    mockPdfBatchUpdateMany.mockResolvedValue({ count: 1 });
    mockJobCreate.mockResolvedValue({ id: 'job-1' });
    mockWaitForLease.mockResolvedValue('lease-1');
    mockReleaseLease.mockResolvedValue(true);
    mockHeartbeatLease.mockResolvedValue(undefined);
    mockDownloadFile.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockRunAuditFromBuffer.mockResolvedValue({
      score: 80, issues: [{ id: 'i1' }, { id: 'i2' }], metadata: { pageCount: 50 },
    });
    mockAutoRemediationRunUpsert.mockResolvedValue({ id: 'run-1', jobId: 'job-1' });
    mockStartAutoLoop.mockResolvedValue(undefined);
    mockJobFindUnique.mockResolvedValue({ id: 'job-1', output: { remediatedFileUrl: 'job-storage/job-1/remediated/book.pdf' } });
    mockListForJob.mockResolvedValue([
      { action: 'reaudit', status: 'completed', resolvedCount: 5, remainingCount: 1 },
    ]);
    // Default: batch stays PROCESSING throughout (not cancelled).
    mockPdfBatchItemCount.mockResolvedValue(0);
  });

  it('runs the full audit -> remediate lifecycle and marks the item REMEDIATED', async () => {
    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockJobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'PDF_ACCESSIBILITY', tenantId: 'tenant-1', userId: 'user-1' }),
    }));
    // QUEUED_FOR_BUDGET / HELD_FOR_BUDGET while waiting on a lease, not
    // AUDITING/REMEDIATING -- a long budget wait shouldn't misrepresent
    // itself as work already in progress.
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'QUEUED_FOR_BUDGET' }),
    });
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'AUDITING', activeLeaseId: 'lease-1' },
    });
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'HELD_FOR_BUDGET' }),
    });
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'REMEDIATING', activeLeaseId: 'lease-1' },
    });

    expect(mockWaitForLease).toHaveBeenCalledWith('tenant-1', 'item-1', 'audit', 1, undefined, expect.anything());
    expect(mockRunAuditFromBuffer).toHaveBeenCalledWith(Buffer.from('pdf-bytes'), 'job-1', 'book.pdf', 'comprehensive');

    // AUDITED update carries the real audit results through.
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'AUDITED', auditScore: 80, issuesFound: 2, pageCount: 50 }),
    });

    // Remediation phase: upserts the run with no overrides, drives the real
    // Auto Mode loop, then reads results back from job.output + history
    // rather than guessing them.
    expect(mockAutoRemediationRunUpsert).toHaveBeenCalledWith({ where: { jobId: 'job-1' }, create: { jobId: 'job-1' }, update: {} });
    expect(mockStartAutoLoop).toHaveBeenCalled();
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({
        status: 'REMEDIATED',
        issuesAutoFixed: 5,
        issuesGuidanceOnly: 1,
        remediatedFilePath: 'job-storage/job-1/remediated/book.pdf',
      }),
    });

    // Both phases' leases released, none left dangling.
    expect(mockReleaseLease).toHaveBeenCalledWith('lease-1');
    expect(mockReleaseLease).toHaveBeenCalledTimes(2);
  });

  it('marks the item SKIPPED without running anything if the batch is already cancelled', async () => {
    mockPdfBatchFindUnique.mockResolvedValue({ ...batch, status: 'CANCELLED' });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockWaitForLease).not.toHaveBeenCalled();
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'SKIPPED', activeLeaseId: null },
    });
  });

  it('skips the remediation phase if the batch is cancelled between phases (audit already ran)', async () => {
    // pdfBatch.findUnique is called: (1) the initial batch fetch in
    // processItem, (2) the isCancelled check before the audit phase,
    // (3) the isCancelled check between phases -- flip to CANCELLED only
    // on that third call, after the audit has already run.
    let call = 0;
    mockPdfBatchFindUnique.mockImplementation(() => {
      call += 1;
      return Promise.resolve(call === 3 ? { ...batch, status: 'CANCELLED' } : batch);
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockRunAuditFromBuffer).toHaveBeenCalled();
    expect(mockStartAutoLoop).not.toHaveBeenCalled();
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'SKIPPED', activeLeaseId: null },
    });
  });

  it('marks the item FAILED with the real error when a lease request exceeds the tenant budget', async () => {
    mockWaitForLease.mockRejectedValue(new Error("[ConcurrencyBudget] weightUnits 99 exceeds the tenant's total budget 10"));

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('exceeds the tenant'),
      }),
    });
    // No lease was ever acquired -- nothing to release.
    expect(mockReleaseLease).not.toHaveBeenCalled();
  });

  it('marks the item FAILED when the audit itself throws, after releasing the held lease', async () => {
    mockRunAuditFromBuffer.mockRejectedValue(new Error('pdf-lib: invalid PDF structure'));

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'FAILED', error: 'pdf-lib: invalid PDF structure' }),
    });
    expect(mockReleaseLease).toHaveBeenCalledWith('lease-1');
    expect(mockStartAutoLoop).not.toHaveBeenCalled();
  });

  it('finalizes the batch to COMPLETED only once every item is terminal (race-safe CAS)', async () => {
    mockPdfBatchItemCount
      .mockResolvedValueOnce(3) // totalCount
      .mockResolvedValueOnce(3); // terminalCount -- all terminal

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('does not finalize the batch while other items are still in flight', async () => {
    mockPdfBatchItemCount
      .mockResolvedValueOnce(3) // totalCount
      .mockResolvedValueOnce(1); // terminalCount -- only this item so far

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    // The QUEUED->PROCESSING transition still fires (every item makes this
    // idempotent call) -- only the COMPLETED finalization should be absent.
    expect(mockPdfBatchUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) })
    );
  });

  it('flips the batch from QUEUED to PROCESSING when an item starts (idempotent CAS)', async () => {
    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', status: 'QUEUED' },
      data: { status: 'PROCESSING' },
    });
  });

  it('ignores re-dispatch of an item that is already terminal -- e.g. BullMQ stalled-job recovery reprocessing an item whose original attempt actually already finished', async () => {
    mockPdfBatchItemFindUnique.mockResolvedValue({ ...draftItem, status: 'FAILED' });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockWaitForLease).not.toHaveBeenCalled();
    expect(mockPdfBatchUpdateMany).not.toHaveBeenCalled();
    expect(mockPdfBatchItemUpdate).not.toHaveBeenCalled();
  });

  it('returns without touching anything if the item no longer exists (e.g. deleted mid-flight)', async () => {
    mockPdfBatchItemFindUnique.mockResolvedValue(null);

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockPdfBatchUpdateMany).not.toHaveBeenCalled();
  });
});

describe('PdfBatchOrchestratorService.reconcileOrphanedItems', () => {
  const orphanedItem = { id: 'item-orphan', batchId: 'batch-1', status: 'AUDITING', activeLeaseId: 'lease-dead' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPdfBatchItemUpdateMany.mockResolvedValue({ count: 1 });
    mockPdfBatchItemCount.mockResolvedValue(0);
    mockPdfBatchUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('does nothing when there are no AUDITING/REMEDIATING items', async () => {
    mockPdfBatchItemFindMany.mockResolvedValue([]);

    const reconciled = await pdfBatchOrchestratorService.reconcileOrphanedItems();

    expect(reconciled).toBe(0);
    expect(mockPdfBatchItemUpdateMany).not.toHaveBeenCalled();
  });

  it('leaves an item alone when its lease is still active (not orphaned)', async () => {
    mockPdfBatchItemFindMany.mockResolvedValue([orphanedItem]);
    mockPdfConcurrencyLeaseFindUnique.mockResolvedValue({ id: 'lease-dead', releasedAt: null });

    const reconciled = await pdfBatchOrchestratorService.reconcileOrphanedItems();

    expect(reconciled).toBe(0);
    expect(mockPdfBatchItemUpdateMany).not.toHaveBeenCalled();
  });

  it('marks FAILED (and finalizes the batch) when the lease was already released -- the process that held it died without transitioning the item', async () => {
    mockPdfBatchItemFindMany.mockResolvedValue([orphanedItem]);
    mockPdfConcurrencyLeaseFindUnique.mockResolvedValue({ id: 'lease-dead', releasedAt: new Date() });
    mockPdfBatchItemCount
      .mockResolvedValueOnce(1) // totalCount
      .mockResolvedValueOnce(1); // terminalCount -- this was the last one

    const reconciled = await pdfBatchOrchestratorService.reconcileOrphanedItems();

    expect(reconciled).toBe(1);
    expect(mockPdfBatchItemUpdateMany).toHaveBeenCalledWith({
      where: { id: 'item-orphan', status: 'AUDITING' },
      data: expect.objectContaining({ status: 'FAILED', activeLeaseId: null }),
    });
    expect(mockPdfBatchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('marks FAILED when there is no lease at all (activeLeaseId missing while supposedly active)', async () => {
    mockPdfBatchItemFindMany.mockResolvedValue([{ ...orphanedItem, activeLeaseId: null }]);

    const reconciled = await pdfBatchOrchestratorService.reconcileOrphanedItems();

    expect(reconciled).toBe(1);
    expect(mockPdfConcurrencyLeaseFindUnique).not.toHaveBeenCalled();
    expect(mockPdfBatchItemUpdateMany).toHaveBeenCalledWith({
      where: { id: 'item-orphan', status: 'AUDITING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('does not double-count a race where the item changed state between the read and the CAS update', async () => {
    mockPdfBatchItemFindMany.mockResolvedValue([orphanedItem]);
    mockPdfConcurrencyLeaseFindUnique.mockResolvedValue({ id: 'lease-dead', releasedAt: new Date() });
    // The real orchestrator itself transitioned the item in the meantime --
    // the CAS matches 0 rows.
    mockPdfBatchItemUpdateMany.mockResolvedValue({ count: 0 });

    const reconciled = await pdfBatchOrchestratorService.reconcileOrphanedItems();

    expect(reconciled).toBe(0);
    expect(mockPdfBatchUpdateMany).not.toHaveBeenCalled();
  });
});
