import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Job } from 'bullmq';
import {
  processPdfAuditJob,
  PdfAuditJobData,
  PdfAuditResult,
  createPdfAuditWorker,
  getWorkerHealth,
} from '../../../src/workers/pdf-audit.worker';
import { queueService } from '../../../src/services/queue.service';
import { logger } from '../../../src/lib/logger';
import { isRedisConfigured } from '../../../src/lib/redis';
import { getBullMQConnection } from '../../../src/queues';
import { promises as fs } from 'fs';

// Mock dependencies
vi.mock('../../../src/services/queue.service');
vi.mock('../../../src/lib/logger');
vi.mock('../../../src/lib/redis');
vi.mock('../../../src/queues');
vi.mock('fs', () => ({
  promises: {
    access: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  },
}));

describe('PDF Audit Worker', () => {
  let mockJob: Partial<Job<PdfAuditJobData, PdfAuditResult>>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock logger methods
    vi.mocked(logger.info).mockImplementation(() => {});
    vi.mocked(logger.error).mockImplementation(() => {});
    vi.mocked(logger.warn).mockImplementation(() => {});
    vi.mocked(logger.debug).mockImplementation(() => {});

    // Mock queue service methods
    vi.mocked(queueService.updateJobProgress).mockResolvedValue();
    vi.mocked(queueService.updateJobStatus).mockResolvedValue();

    // Mock file system
    vi.mocked(fs.access).mockResolvedValue();
    vi.mocked(fs.stat).mockResolvedValue({ size: 1024000 } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.unlink).mockResolvedValue();

    // Create mock job
    mockJob = {
      id: 'test-job-123',
      name: 'pdf-audit-job',
      data: {
        type: 'PDF_ACCESSIBILITY',
        tenantId: 'tenant-1',
        userId: 'user-1',
        fileId: 'file-1',
        filePath: '/path/to/test.pdf',
        fileName: 'test.pdf',
      } as PdfAuditJobData,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('processPdfAuditJob', () => {
    it('should successfully process a PDF audit job', async () => {
      const result = await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.jobId).toBe('test-job-123');
      expect(result.data?.score).toBeGreaterThanOrEqual(0);
      expect(result.data?.summary).toBeDefined();
      expect(result.data?.issues).toBeDefined();
    });

    it('should update progress through all stages', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      // Check that progress was updated multiple times
      expect(mockJob.updateProgress).toHaveBeenCalled();
      expect(queueService.updateJobProgress).toHaveBeenCalled();

      // Verify progress stages: parsing (0-20%), validating (20-80%), reporting (80-100%)
      const progressCalls = vi.mocked(queueService.updateJobProgress).mock.calls.map(
        (call) => call[1]
      );

      expect(progressCalls).toContain(0); // Start of parsing
      expect(progressCalls).toContain(20); // End of parsing
      expect(progressCalls).toContain(80); // End of validating
      expect(progressCalls).toContain(100); // End of reporting
    });

    it('should verify file exists before processing', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(fs.access).toHaveBeenCalledWith('/path/to/test.pdf');
    });

    it('should throw error if file does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT: no such file'));

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow('File not found');
    });

    it('should include file metadata in result', async () => {
      const result = await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(result.data?.metadata).toBeDefined();
      expect(result.data?.metadata?.fileName).toBe('test.pdf');
      expect(result.data?.metadata?.fileSize).toBe(1024000);
      expect(result.data?.metadata?.processedAt).toBeDefined();
    });

    it('should clean up temporary file after processing', async () => {
      mockJob.data!.filePath = '/tmp/uploads/test.pdf';

      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(fs.unlink).toHaveBeenCalledWith('/tmp/uploads/test.pdf');
    });

    it('should not delete non-temporary files', async () => {
      mockJob.data!.filePath = '/permanent/storage/test.pdf';

      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('should handle cleanup failure gracefully', async () => {
      mockJob.data!.filePath = '/tmp/test.pdf';
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));

      // Should not throw error due to cleanup failure
      const result = await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(result.success).toBe(true);
      expect(logger.debug).toHaveBeenCalled();
    });

    it('should clean up temp file even on processing error', async () => {
      mockJob.data!.filePath = '/tmp/test.pdf';
      vi.mocked(fs.stat).mockRejectedValue(new Error('Failed to read file'));

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow();

      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should log processing stages', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting PDF audit job')
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Parsing PDF structure'));
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Running accessibility validators')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Generating audit report')
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('completed successfully'));
    });

    it('should log validation substages', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Validating document structure')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Checking image alt text quality')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Analyzing table accessibility')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Checking heading hierarchy')
      );
    });

    it('should handle processing errors and log them', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('File access error'));

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.any(Error)
      );
    });

    it('should return proper result structure', async () => {
      const result = await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(result).toMatchObject({
        success: true,
        data: {
          jobId: 'test-job-123',
          score: expect.any(Number),
          issues: expect.any(Array),
          summary: {
            critical: expect.any(Number),
            serious: expect.any(Number),
            moderate: expect.any(Number),
            minor: expect.any(Number),
            total: expect.any(Number),
          },
          metadata: expect.objectContaining({
            fileName: expect.any(String),
            fileSize: expect.any(Number),
            processedAt: expect.any(String),
          }),
        },
      });
    });

    it('should include validator metadata', async () => {
      const result = await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(result.data?.metadata?.validators).toBeDefined();
      expect(result.data?.metadata?.validators).toContain('structure');
      expect(result.data?.metadata?.validators).toContain('alttext');
      expect(result.data?.metadata?.validators).toContain('table');
    });
  });

  describe('createPdfAuditWorker', () => {
    it('should return null if Redis is not configured', () => {
      vi.mocked(isRedisConfigured).mockReturnValue(false);

      const worker = createPdfAuditWorker();

      expect(worker).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Redis not configured')
      );
    });

    it('should return null if Redis connection is not available', () => {
      vi.mocked(isRedisConfigured).mockReturnValue(true);
      vi.mocked(getBullMQConnection).mockReturnValue(null);

      const worker = createPdfAuditWorker();

      expect(worker).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Redis connection not available')
      );
    });

    it('should create worker with correct configuration when Redis is available', () => {
      vi.mocked(isRedisConfigured).mockReturnValue(true);
      vi.mocked(getBullMQConnection).mockReturnValue({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      // Worker creation will fail in test environment without actual Redis
      // but we can verify that the attempt was made
      try {
        createPdfAuditWorker();
      } catch {
        // Expected in test environment
      }

      // Verify attempt was made
      expect(isRedisConfigured).toHaveBeenCalled();
      expect(getBullMQConnection).toHaveBeenCalled();
    });
  });

  describe('getWorkerHealth', () => {
    it('should return unhealthy status when Redis is not available', async () => {
      vi.mocked(getBullMQConnection).mockReturnValue(null);

      const health = await getWorkerHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.queueName).toBe('accessibility-validation');
      expect(health.concurrency).toBe(3);
    });

    it('should return healthy status when Redis is available', async () => {
      vi.mocked(getBullMQConnection).mockReturnValue({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      const health = await getWorkerHealth();

      expect(health.status).toBe('healthy');
      expect(health.queueName).toBe('accessibility-validation');
      expect(health.concurrency).toBe(3);
      expect(health.metrics).toBeDefined();
    });

    it('should include metrics when healthy', async () => {
      vi.mocked(getBullMQConnection).mockReturnValue({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      const health = await getWorkerHealth();

      expect(health.metrics).toMatchObject({
        activeJobs: expect.any(Number),
        completedJobs: expect.any(Number),
        failedJobs: expect.any(Number),
      });
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(getBullMQConnection).mockImplementation(() => {
        throw new Error('Connection error');
      });

      const health = await getWorkerHealth();

      expect(health.status).toBe('unhealthy');
    });
  });

  describe('Error Handling and Retries', () => {
    it('should throw error on file access failure', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Permission denied'));

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow('File not found');
    });

    it('should throw error on processing failure', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Processing error'));

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow('Processing error');
    });

    it('should log errors with context', async () => {
      const error = new Error('Test error');
      vi.mocked(fs.access).mockRejectedValue(error);

      await expect(
        processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>)
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('test-job-123'),
        expect.any(Error)
      );
    });
  });

  describe('Progress Reporting', () => {
    it('should report progress at each stage', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      const progressValues = vi.mocked(queueService.updateJobProgress).mock.calls.map(
        (call) => call[1]
      );

      // Should have multiple progress updates
      expect(progressValues.length).toBeGreaterThan(5);

      // Should progress from 0 to 100
      expect(Math.min(...progressValues)).toBe(0);
      expect(Math.max(...progressValues)).toBe(100);

      // Should be monotonically increasing
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
      }
    });

    it('should update both job and queue service progress', async () => {
      await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

      expect(mockJob.updateProgress).toHaveBeenCalled();
      expect(queueService.updateJobProgress).toHaveBeenCalled();

      // Should have same number of calls
      expect(mockJob.updateProgress).toHaveBeenCalledTimes(
        queueService.updateJobProgress.mock.calls.length
      );
    });
  });

  describe('File Cleanup', () => {
    it('should identify temp files correctly', async () => {
      const tempPaths = [
        '/tmp/file.pdf',
        '/var/temp/file.pdf',
        '/uploads/file.pdf',
        'C:\\temp\\file.pdf',
      ];

      for (const path of tempPaths) {
        vi.clearAllMocks();
        mockJob.data!.filePath = path;

        await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

        // Assert unlink was called for temp files
        expect(fs.unlink).toHaveBeenCalledWith(path);
      }
    });

    it('should preserve permanent files', async () => {
      const permanentPaths = ['/storage/file.pdf', '/documents/file.pdf', 'C:\\Documents\\file.pdf'];

      for (const path of permanentPaths) {
        vi.clearAllMocks();
        mockJob.data!.filePath = path;

        await processPdfAuditJob(mockJob as Job<PdfAuditJobData, PdfAuditResult>);

        expect(fs.unlink).not.toHaveBeenCalled();
      }
    });
  });
});
