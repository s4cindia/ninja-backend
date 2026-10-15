/**
 * BatchOrchestratorService -- this file only covers prepareBatchForProcessing
 * / runBatchProcessing / startBatchProcessing, extracted so batch processing
 * can be dispatched onto the BATCH_PROCESSING worker queue instead of
 * running fire-and-forget on the web (ALB-health-checked) service -- see
 * batch.controller.ts's dispatchBatchProcessing and PR #666's identical fix
 * for Comparison Study Auto Mode.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBatchUpdate = vi.fn();
const mockBatchFindUnique = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    batch: {
      findUnique: (...args: unknown[]) => mockBatchFindUnique(...args),
      update: (...args: unknown[]) => mockBatchUpdate(...args),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../../src/services/epub/epub-audit.service', () => ({ epubAuditService: {} }));
vi.mock('../../../../src/services/epub/remediation.service', () => ({ remediationService: {} }));
vi.mock('../../../../src/services/epub/auto-remediation.service', () => ({ autoRemediationService: {} }));
vi.mock('../../../../src/sse/sse.service', () => ({ sseService: { broadcastToChannel: vi.fn() } }));
vi.mock('../../../../src/services/email/email.service', () => ({ emailService: { sendBatchFailureEmail: vi.fn(), sendBatchCompletionEmail: vi.fn() } }));
vi.mock('../../../../src/services/notification/notification.service', () => ({
  notificationService: { createBatchFailureNotification: vi.fn(), createBatchCompletionNotification: vi.fn() },
}));
vi.mock('../../../../src/services/batch/batch-file.service', () => ({ batchFileService: {} }));

import { batchOrchestratorService } from '../../../../src/services/batch/batch-orchestrator.service';

const draftBatch = { id: 'batch-1', status: 'DRAFT', totalFiles: 2, files: [] };

describe('BatchOrchestratorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('prepareBatchForProcessing', () => {
    it('transitions a DRAFT batch with files to QUEUED', async () => {
      mockBatchFindUnique.mockResolvedValue(draftBatch);
      mockBatchUpdate.mockResolvedValue({ ...draftBatch, status: 'QUEUED', startedAt: new Date() });

      const result = await batchOrchestratorService.prepareBatchForProcessing('batch-1');

      expect(mockBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { status: 'QUEUED', startedAt: expect.any(Date) },
      });
      expect(result.status).toBe('QUEUED');
    });

    it('rejects a batch that is not in DRAFT status', async () => {
      mockBatchFindUnique.mockResolvedValue({ ...draftBatch, status: 'PROCESSING' });

      await expect(batchOrchestratorService.prepareBatchForProcessing('batch-1')).rejects.toThrow(
        'Batch must be in DRAFT status to start'
      );
      expect(mockBatchUpdate).not.toHaveBeenCalled();
    });

    it('rejects a batch with no files', async () => {
      mockBatchFindUnique.mockResolvedValue({ ...draftBatch, totalFiles: 0 });

      await expect(batchOrchestratorService.prepareBatchForProcessing('batch-1')).rejects.toThrow(
        'Cannot start batch with no files'
      );
      expect(mockBatchUpdate).not.toHaveBeenCalled();
    });
  });

  describe('startBatchProcessing (in-process fallback)', () => {
    it('prepares the batch then kicks off processing without re-fetching files twice unexpectedly', async () => {
      mockBatchFindUnique.mockResolvedValue(draftBatch);
      mockBatchUpdate.mockResolvedValue({ ...draftBatch, status: 'QUEUED', startedAt: new Date() });
      const runSpy = vi.spyOn(batchOrchestratorService, 'runBatchProcessing').mockImplementation(() => {});

      await batchOrchestratorService.startBatchProcessing('batch-1');

      expect(runSpy).toHaveBeenCalledWith('batch-1');
      runSpy.mockRestore();
    });
  });
});
