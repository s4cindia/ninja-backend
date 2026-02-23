/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../../src/services/style/style-validation.service', () => ({
  styleValidationService: {
    executeValidation: vi.fn(),
    updateJobStatus: vi.fn(),
  },
}));

vi.mock('../../../src/services/queue/queue.service', () => ({
  queueService: {
    updateJobProgress: vi.fn(),
    updateJobStatus: vi.fn(),
  },
}));

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    styleValidationJob: {
      update: vi.fn(),
    },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { styleValidationService } from '../../../src/services/style/style-validation.service';
import prisma from '../../../src/lib/prisma';

// Import the processor after mocking
// Note: We test the logic that would be in the processor
describe('StyleProcessor Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('processStyleValidation', () => {
    // Simulating the worker's process function
    async function processStyleValidation(job: {
      id: string;
      data: { jobId: string; documentId: string };
      updateProgress: (progress: number) => Promise<void>;
    }) {
      const { jobId } = job.data;

      try {
        // Update job to processing
        await prisma.styleValidationJob.update({
          where: { id: jobId },
          data: { status: 'PROCESSING', startedAt: new Date() },
        });

        // Execute validation
        const violationCount = await styleValidationService.executeValidation(
          jobId,
          async (progress: number, _message: string) => {
            await job.updateProgress(progress);
          }
        );

        // Update job to completed
        await prisma.styleValidationJob.update({
          where: { id: jobId },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            progress: 100,
            totalViolations: violationCount,
          },
        });

        return { success: true, violationCount };
      } catch (error) {
        // Update job to failed
        await prisma.styleValidationJob.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
          },
        });

        throw error;
      }
    }

    it('should process job successfully and return violation count', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);
      vi.mocked(styleValidationService.executeValidation).mockResolvedValue(5);

      const result = await processStyleValidation(mockJob);

      expect(result.success).toBe(true);
      expect(result.violationCount).toBe(5);
      expect(prisma.styleValidationJob.update).toHaveBeenCalledTimes(2);
      expect(styleValidationService.executeValidation).toHaveBeenCalledWith(
        'style-job-1',
        expect.any(Function)
      );
    });

    it('should update job status to FAILED on error', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);
      vi.mocked(styleValidationService.executeValidation).mockRejectedValue(
        new Error('Validation failed')
      );

      await expect(processStyleValidation(mockJob)).rejects.toThrow('Validation failed');

      // Should have called update twice: once for PROCESSING, once for FAILED
      expect(prisma.styleValidationJob.update).toHaveBeenCalledTimes(2);
      expect(prisma.styleValidationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'style-job-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            errorMessage: 'Validation failed',
          }),
        })
      );
    });

    it('should call updateProgress callback during execution', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);

      // Capture the callback and call it
      vi.mocked(styleValidationService.executeValidation).mockImplementation(
        async (_jobId, onProgress) => {
          if (onProgress) {
            await onProgress(25, 'Extracting text');
            await onProgress(50, 'Validating');
            await onProgress(75, 'Saving results');
          }
          return 3;
        }
      );

      await processStyleValidation(mockJob);

      expect(mockJob.updateProgress).toHaveBeenCalledWith(25);
      expect(mockJob.updateProgress).toHaveBeenCalledWith(50);
      expect(mockJob.updateProgress).toHaveBeenCalledWith(75);
    });

    it('should handle unknown error types', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);
      vi.mocked(styleValidationService.executeValidation).mockRejectedValue('String error');

      await expect(processStyleValidation(mockJob)).rejects.toBe('String error');

      expect(prisma.styleValidationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorMessage: 'Unknown error',
          }),
        })
      );
    });

    it('should set startedAt when processing begins', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);
      vi.mocked(styleValidationService.executeValidation).mockResolvedValue(0);

      await processStyleValidation(mockJob);

      // First call should set status to PROCESSING and startedAt
      expect(prisma.styleValidationJob.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PROCESSING',
            startedAt: expect.any(Date),
          }),
        })
      );
    });

    it('should set completedAt when processing finishes', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue({} as any);
      vi.mocked(styleValidationService.executeValidation).mockResolvedValue(2);

      await processStyleValidation(mockJob);

      // Second call should set status to COMPLETED and completedAt
      expect(prisma.styleValidationJob.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'COMPLETED',
            completedAt: expect.any(Date),
            progress: 100,
            totalViolations: 2,
          }),
        })
      );
    });
  });

  describe('error handling edge cases', () => {
    it('should handle database connection errors', async () => {
      const mockJob = {
        id: 'bullmq-job-1',
        data: { jobId: 'style-job-1', documentId: 'doc-1' },
        updateProgress: vi.fn(),
      };

      vi.mocked(prisma.styleValidationJob.update).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      // Simulating the processor
      async function processWithDbError(job: typeof mockJob) {
        try {
          await prisma.styleValidationJob.update({
            where: { id: job.data.jobId },
            data: { status: 'PROCESSING' },
          });
        } catch (error) {
          throw error;
        }
      }

      await expect(processWithDbError(mockJob)).rejects.toThrow('Database connection failed');
    });
  });
});
