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
const mockJobUpdateMany = vi.fn();
const mockJobFindUnique = vi.fn();
const mockAutoRemediationRunUpsert = vi.fn();
const mockAutoRemediationRunFindUnique = vi.fn();

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
      updateMany: (...args: unknown[]) => mockJobUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockJobFindUnique(...args),
    },
    pdfAutoRemediationRun: {
      upsert: (...args: unknown[]) => mockAutoRemediationRunUpsert(...args),
      findUnique: (...args: unknown[]) => mockAutoRemediationRunFindUnique(...args),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockDownloadFile = vi.fn();
const mockSaveFile = vi.fn();
vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
    saveFile: (...args: unknown[]) => mockSaveFile(...args),
  },
}));

const mockAutoTagIfNeeded = vi.fn();
vi.mock('../../../../src/services/pdf/pdf-auto-tag-orchestrator.service', () => ({
  autoTagIfNeeded: (...args: unknown[]) => mockAutoTagIfNeeded(...args),
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
    // auditJobId: 'job-1' matches what mockJobCreate resolves below -- a
    // later findUnique (e.g. finalizeDanglingQueuedJob's own lookup) sees
    // the same id runAuditPhase's QUEUED_FOR_BUDGET update actually persisted.
    mockPdfBatchItemFindUnique.mockResolvedValue({ ...draftItem, auditJobId: 'job-1' });
    mockPdfBatchItemFindUniqueOrThrow.mockResolvedValue({ ...draftItem, effectiveWeightUnits: 2 });
    mockPdfBatchItemUpdate.mockResolvedValue(draftItem);
    mockPdfBatchUpdateMany.mockResolvedValue({ count: 1 });
    mockJobCreate.mockResolvedValue({ id: 'job-1' });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });
    mockWaitForLease.mockResolvedValue('lease-1');
    mockReleaseLease.mockResolvedValue(true);
    mockHeartbeatLease.mockResolvedValue(undefined);
    mockDownloadFile.mockResolvedValue(Buffer.from('pdf-bytes'));
    mockSaveFile.mockResolvedValue('job-storage/job-1/book.pdf');
    // Default: already tagged, nothing to do -- matches the real function's
    // own "no-op" outcome, just explicit instead of incidental.
    mockAutoTagIfNeeded.mockResolvedValue({
      auditBuffer: Buffer.from('pdf-bytes'),
      isTagged: true,
      autoTagMeta: { autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged' },
    });
    mockRunAuditFromBuffer.mockResolvedValue({
      score: 80, issues: [{ id: 'i1' }, { id: 'i2' }], metadata: { pageCount: 50 },
    });
    mockAutoRemediationRunUpsert.mockResolvedValue({ id: 'run-1', jobId: 'job-1' });
    mockAutoRemediationRunFindUnique.mockResolvedValue({ id: 'run-1', jobId: 'job-1', autoStopReason: 'converged', autoRoundsCompleted: 3 });
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
    // Real incident (2026-10-19): this used to create the job already
    // 'PROCESSING' with a real startedAt, so cleanupStalePdfJobs's 20-minute
    // staleness watchdog killed FMHE_PDF.pdf's audit job as "orphaned" after
    // 20 minutes of pure QUEUED_FOR_BUDGET waiting (large items legitimately
    // monopolize the whole tenant budget for 30-90+ minutes, by design) --
    // it never did a single second of real work. 'QUEUED' (the schema's own
    // default) is invisible to that watchdog's query (status: 'PROCESSING'
    // only); only once the lease is actually granted does the job flip to
    // 'PROCESSING' with its real startedAt.
    expect(mockJobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'QUEUED' }),
    }));
    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'PROCESSING', startedAt: expect.any(Date) },
    });
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
    // Real incident (2026-10-18): without this, every batch item's
    // remediation phase failed on its first round with "PDF file not found
    // in storage" -- ai-analysis.service.ts's analyzeJob() loads the PDF via
    // fileStorageService.getFile(jobId, fileName), which only ever finds
    // something here saveFile wrote first.
    expect(mockSaveFile).toHaveBeenCalledWith('job-1', 'book.pdf', Buffer.from('pdf-bytes'));
    // Real incident (2026-10-18): this orchestrator never ran Seam C /
    // Adobe AutoTag at all -- it called pdfAuditService.runAuditFromBuffer
    // directly, bypassing accessibility.processor.ts entirely (the only
    // place that decision ever lived). No forceAutoTag equivalent for batch
    // items (out of scope -- see pdf-auto-tag-orchestrator.service.ts's own
    // doc comment).
    expect(mockAutoTagIfNeeded).toHaveBeenCalledWith(Buffer.from('pdf-bytes'), 'job-1', 'book.pdf', false);
    // Real gap (2026-10-18): this call used to pass none of runAuditFromBuffer's
    // progress callbacks, so a batch item's Job.input never got totalPages/
    // validatorProgress written -- GET /jobs/:auditJobId had nothing to show
    // during a batch item's audit phase, unlike the single-file worker's
    // equivalent call. Runs against autoTagIfNeeded's own returned
    // auditBuffer (here the same bytes, per this suite's mock), not the raw
    // downloaded buffer.
    expect(mockRunAuditFromBuffer).toHaveBeenCalledWith(
      Buffer.from('pdf-bytes'), 'job-1', 'book.pdf', 'comprehensive',
      undefined, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function)
    );

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

  it('carries the batch\'s own Auto Mode overrides onto this item\'s PdfAutoRemediationRun -- each item still gets its own independent budget/round count, not a shared pool', async () => {
    mockPdfBatchFindUnique.mockResolvedValue({
      ...batch,
      autoMaxRounds: 3,
      autoCostLimitUsd: 0.5,
      autoColorContrastMode: 'disabled',
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    const overrideFields = { autoMaxRounds: 3, autoCostLimitUsd: 0.5, autoColorContrastMode: 'disabled' };
    expect(mockAutoRemediationRunUpsert).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      create: { jobId: 'job-1', ...overrideFields },
      update: overrideFields,
    });
  });

  it('leaves the PdfAutoRemediationRun upsert with no overrides when the batch has no Auto Mode settings -- NULL means "use the system default", same as today', async () => {
    mockPdfBatchFindUnique.mockResolvedValue({
      ...batch,
      autoMaxRounds: null,
      autoCostLimitUsd: null,
      autoColorContrastMode: null,
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockAutoRemediationRunUpsert).toHaveBeenCalledWith({ where: { jobId: 'job-1' }, create: { jobId: 'job-1' }, update: {} });
  });

  it('audits the tagged buffer (not the original) when autoTagIfNeeded actually tags an untagged PDF, and merges autoTagMeta into job.output', async () => {
    const taggedBuffer = Buffer.from('tagged-pdf-bytes');
    mockAutoTagIfNeeded.mockResolvedValue({
      auditBuffer: taggedBuffer,
      isTagged: false,
      autoTagMeta: { autoTagStatus: 'complete', taggerSource: 'seam-c' },
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockRunAuditFromBuffer).toHaveBeenCalledWith(
      taggedBuffer, 'job-1', 'book.pdf', 'comprehensive',
      undefined, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function)
    );
    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        output: expect.objectContaining({ autoTagStatus: 'complete', taggerSource: 'seam-c' }),
      }),
    });
  });

  it('strips NUL bytes from the audit report before persisting job.output (real incident, 2026-10-19: FMHE_PDF.pdf)', async () => {
    // pdfjs emits U+0000 for an unmapped glyph on STEM/CID-font PDFs (this
    // exact document had 2560 of 3457 fonts missing /ToUnicode) -- a raw NUL
    // byte anywhere in an issue's message/context string aborts the WHOLE
    // Postgres write with "unsupported Unicode escape sequence... \u0000
    // cannot be converted to text" (error 22P05), failing the item even
    // though the audit itself succeeded. The single-file worker's equivalent
    // write already guards against this (queueService.updateJobStatus); this
    // orchestrator calls prisma.job.update directly and never got the same
    // protection until now.
    mockRunAuditFromBuffer.mockResolvedValue({
      score: 61,
      issues: [{ id: 'i1', message: 'Font glyph decoded as \u0000 (unmapped)' }],
      metadata: { pageCount: 2040 },
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        output: expect.objectContaining({
          auditReport: expect.objectContaining({
            issues: [{ id: 'i1', message: 'Font glyph decoded as  (unmapped)' }],
          }),
        }),
      }),
    });
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
    // The Job row was created 'QUEUED' and never reached 'PROCESSING' (the
    // lease wait failed first) -- without finalizeDanglingQueuedJob, it
    // would sit QUEUED forever, invisible to cleanupStalePdfJobs's watchdog.
    expect(mockJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'QUEUED' },
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('exceeds the tenant') }),
    });
  });

  it('cancels (not fails) the dangling QUEUED job when the batch is cancelled while still waiting for the concurrency lease', async () => {
    // Calls to pdfBatch.findUnique: (1) processItem's initial batch fetch,
    // (2) isCancelled before runAuditPhase -- both still PROCESSING, so the
    // audit phase proceeds and the job is created; (3) isCancelled inside
    // processItem's catch block, after the lease wait itself aborts --
    // CANCELLED, same call-counting technique as the "cancelled between
    // phases" test above.
    let call = 0;
    mockPdfBatchFindUnique.mockImplementation(() => {
      call += 1;
      return Promise.resolve(call >= 3 ? { ...batch, status: 'CANCELLED' } : batch);
    });
    mockWaitForLease.mockRejectedValue(new Error('aborted'));

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'SKIPPED', activeLeaseId: null },
    });
    expect(mockJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'QUEUED' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    });
  });

  it('still releases the lease if flipping the item/job to AUDITING/PROCESSING fails right after acquiring it (CodeRabbit finding, PR #701)', async () => {
    mockPdfBatchItemUpdate.mockImplementation((args: { data?: { status?: string } }) => {
      if (args.data?.status === 'AUDITING') return Promise.reject(new Error('transient DB error'));
      return Promise.resolve(draftItem);
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    // The lease WAS acquired (waitForLease resolved) before this failure --
    // without moving the AUDITING/PROCESSING flips inside the try whose
    // finally releases it, this would leak forever.
    expect(mockReleaseLease).toHaveBeenCalledWith('lease-1');
    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'FAILED', error: 'transient DB error' }),
    });
  });

  it('finalizes the orphaned job directly via its own job.id when linking it to the item fails (CodeRabbit finding, PR #701)', async () => {
    // The very first pdfBatchItem.update call is the QUEUED_FOR_BUDGET link
    // write (auditJobId: job.id) -- fail only that one.
    let linkAttempted = false;
    mockPdfBatchItemUpdate.mockImplementation((args: { data?: { status?: string } }) => {
      if (args.data?.status === 'QUEUED_FOR_BUDGET' && !linkAttempted) {
        linkAttempted = true;
        return Promise.reject(new Error('connection pool exhausted'));
      }
      return Promise.resolve(draftItem);
    });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    // Never reached the lease wait at all -- the link failure throws first.
    expect(mockWaitForLease).not.toHaveBeenCalled();
    // finalizeDanglingQueuedJob (processItem's catch block) can't find this
    // job via the item -- the link write that would have set auditJobId is
    // exactly what failed. The inline fallback inside runAuditPhase itself
    // (using the locally-known job.id, not an item lookup) is what actually
    // finalizes it here.
    expect(mockJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'QUEUED' },
      data: expect.objectContaining({ status: 'FAILED', error: 'connection pool exhausted' }),
    });
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

  it('marks the item FAILED (not REMEDIATED) when the auto-mode loop stops immediately with zero rounds completed -- real incident, 2026-10-17: startAutoLoop never throws, so this used to silently fall through to a misleading "Remediated" badge with 0 fixes and no download link', async () => {
    mockAutoRemediationRunFindUnique.mockResolvedValue({ id: 'run-1', jobId: 'job-1', autoStopReason: 'error', autoRoundsCompleted: 0 });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('no rounds completed'),
      }),
    });
    expect(mockPdfBatchItemUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REMEDIATED' }) })
    );
    // The held remediation lease still gets released even though this
    // throws instead of returning normally (runRemediationPhase's own
    // finally block).
    expect(mockReleaseLease).toHaveBeenCalledWith('lease-1');
    expect(mockReleaseLease).toHaveBeenCalledTimes(2);
  });

  it('still marks the item REMEDIATED when the loop stops on an error after completing at least one round (partial progress preserved, not discarded)', async () => {
    mockAutoRemediationRunFindUnique.mockResolvedValue({ id: 'run-1', jobId: 'job-1', autoStopReason: 'error', autoRoundsCompleted: 2 });

    await pdfBatchOrchestratorService.processItem('batch-1', 'item-1');

    expect(mockPdfBatchItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: expect.objectContaining({ status: 'REMEDIATED' }),
    });
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
