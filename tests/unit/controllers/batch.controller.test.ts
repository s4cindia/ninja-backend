/**
 * BatchController -- this file only covers startBatch/dispatchBatchProcessing,
 * which routes batch processing through the BATCH_PROCESSING BullMQ queue
 * (worker process) when queues are available, falling back to the original
 * direct in-process call otherwise. Same pattern/same bug class as
 * pdf-auto-mode.controller.ts's enqueueOrRunAutoLoop (PR #666) -- see
 * tests/unit/controllers/pdf-auto-mode.controller.test.ts for the precedent
 * this file mirrors.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';

vi.mock('../../../src/services/batch/batch-orchestrator.service', () => ({
  batchOrchestratorService: {
    getBatchForUser: vi.fn(),
    prepareBatchForProcessing: vi.fn(),
    runBatchProcessing: vi.fn(),
    startBatchProcessing: vi.fn(),
  },
}));

vi.mock('../../../src/queues', () => ({
  areQueuesAvailable: vi.fn(),
  getBatchProcessingQueue: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { batchController } from '../../../src/controllers/batch.controller';
import { batchOrchestratorService } from '../../../src/services/batch/batch-orchestrator.service';
import { areQueuesAvailable, getBatchProcessingQueue } from '../../../src/queues';

const mockQueueAdd = vi.fn();

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(): AuthenticatedRequest {
  return {
    params: { batchId: 'batch-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
  } as unknown as AuthenticatedRequest;
}

const preparedBatch = { id: 'batch-1', status: 'QUEUED', totalFiles: 2, startedAt: new Date() };
const startedBatch = { id: 'batch-1', status: 'PROCESSING', totalFiles: 2, startedAt: new Date() };

describe('BatchController.startBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: queues available, matching real deployed behavior. Individual
    // tests override this to false to exercise the in-process fallback.
    vi.mocked(areQueuesAvailable).mockReturnValue(true);
    vi.mocked(getBatchProcessingQueue).mockReturnValue({ add: mockQueueAdd } as any);
    mockQueueAdd.mockResolvedValue(undefined);
    vi.mocked(batchOrchestratorService.getBatchForUser).mockResolvedValue({} as any);
    vi.mocked(batchOrchestratorService.prepareBatchForProcessing).mockResolvedValue(preparedBatch as any);
    vi.mocked(batchOrchestratorService.startBatchProcessing).mockResolvedValue(startedBatch as any);
  });

  it('enqueues onto the BATCH_PROCESSING queue when queues are available', async () => {
    const res = makeRes();

    await batchController.startBatch(makeReq(), res);

    expect(batchOrchestratorService.prepareBatchForProcessing).toHaveBeenCalledWith('batch-1');
    // Dispatch id is unique per attempt (`${batchId}-${Date.now()}`), not the
    // bare batchId -- same reasoning as enqueueOrRunAutoLoop: a wedged,
    // never-completed BullMQ entry from a crashed worker must not block a
    // retry from reusing the same id.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'batch-processing-batch-1',
      { batchId: 'batch-1', tenantId: 'tenant-1' },
      { jobId: expect.stringMatching(/^batch-1-\d+$/) }
    );
    expect(batchOrchestratorService.startBatchProcessing).not.toHaveBeenCalled();
    expect(batchOrchestratorService.runBatchProcessing).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { batchId: 'batch-1', status: 'QUEUED', totalFiles: 2, startedAt: preparedBatch.startedAt },
    });
  });

  it('falls back to running in-process when enqueueing itself fails (batch is already QUEUED by then)', async () => {
    mockQueueAdd.mockRejectedValue(new Error('redis unavailable'));
    const res = makeRes();

    await batchController.startBatch(makeReq(), res);
    // dispatchBatchProcessing doesn't await the queue.add().catch(...) chain,
    // so let its microtask settle before asserting the fallback ran.
    await new Promise((resolve) => setImmediate(resolve));

    expect(batchOrchestratorService.prepareBatchForProcessing).toHaveBeenCalledWith('batch-1');
    expect(batchOrchestratorService.runBatchProcessing).toHaveBeenCalledWith('batch-1');
    // Must NOT call startBatchProcessing here -- it would re-validate DRAFT
    // status, which the batch is no longer in (already moved to QUEUED).
    expect(batchOrchestratorService.startBatchProcessing).not.toHaveBeenCalled();
  });

  it('falls back to startBatchProcessing (fully in-process) when queues are unavailable, e.g. local dev without Redis', async () => {
    vi.mocked(areQueuesAvailable).mockReturnValue(false);
    const res = makeRes();

    await batchController.startBatch(makeReq(), res);

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(batchOrchestratorService.prepareBatchForProcessing).not.toHaveBeenCalled();
    expect(batchOrchestratorService.startBatchProcessing).toHaveBeenCalledWith('batch-1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { batchId: 'batch-1', status: 'PROCESSING', totalFiles: 2, startedAt: startedBatch.startedAt },
    });
  });

  it('returns 500 when the batch is not accessible to this user', async () => {
    vi.mocked(batchOrchestratorService.getBatchForUser).mockRejectedValue(new Error('Batch not found or access denied'));
    const res = makeRes();

    await batchController.startBatch(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
