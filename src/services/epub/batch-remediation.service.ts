import { autoRemediationService } from './auto-remediation.service';
import { epubComparisonService } from './epub-comparison.service';
import { fileStorageService } from '../storage/file-storage.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { Prisma, JobStatus } from '@prisma/client';
import { sseService } from '../../sse/sse.service';
import { getBatchQueue, areQueuesAvailable } from '../../queues';

type BatchStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

interface BatchJob {
  jobId: string;
  fileName: string;
  status: BatchStatus;
  issuesFixed?: number;
  issuesFailed?: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

interface AcrGenerationHistoryEntry {
  mode: 'individual' | 'aggregate';
  acrWorkflowIds: string[];
  generatedAt: string;
  generatedBy: string;
}

interface BatchRemediationResult {
  batchId: string;
  status: BatchStatus;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  jobs: BatchJob[];
  summary: {
    totalIssuesFixed: number;
    totalIssuesFailed: number;
    successRate: number;
  };
  startedAt: Date;
  completedAt?: Date;
  acrGenerated?: boolean;
  acrMode?: 'individual' | 'aggregate';
  acrWorkflowIds?: string[];
  acrGeneratedAt?: string;
  acrGenerationHistory?: AcrGenerationHistoryEntry[];
}

interface BatchOptions {
  fixCodes?: string[];
  stopOnError?: boolean;
  generateComparison?: boolean;
  notifyOnComplete?: boolean;
}

class BatchRemediationService {
  private activeBatches: Map<string, BatchRemediationResult> = new Map();

  async createBatch(
    jobIds: string[],
    tenantId: string,
    userId: string,
    options: BatchOptions = {}
  ): Promise<BatchRemediationResult> {
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const jobs = await prisma.job.findMany({
      where: {
        id: { in: jobIds },
        tenantId,
      },
    });

    if (jobs.length !== jobIds.length) {
      const foundIds = new Set(jobs.map(j => j.id));
      const missingIds = jobIds.filter(id => !foundIds.has(id));
      throw new Error(`Jobs not found: ${missingIds.join(', ')}`);
    }

    const batchJobs: BatchJob[] = jobs.map(job => ({
      jobId: job.id,
      fileName: (job.input as { fileName?: string })?.fileName || 'unknown.epub',
      status: 'pending' as BatchStatus,
    }));

    const result: BatchRemediationResult = {
      batchId,
      status: 'pending',
      totalJobs: batchJobs.length,
      completedJobs: 0,
      failedJobs: 0,
      jobs: batchJobs,
      summary: {
        totalIssuesFixed: 0,
        totalIssuesFailed: 0,
        successRate: 0,
      },
      startedAt: new Date(),
    };

    await prisma.job.create({
      data: {
        id: batchId,
        tenantId,
        userId,
        type: 'BATCH_VALIDATION',
        status: JobStatus.QUEUED,
        input: {
          recordType: 'batch_remediation',
          jobIds,
          options: JSON.parse(JSON.stringify(options)),
        } as Prisma.InputJsonValue,
        output: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
      },
    });

    this.activeBatches.set(batchId, result);

    logger.info(`Created batch remediation ${batchId} with ${jobIds.length} jobs`);

    return result;
  }

  async processBatch(
    batchId: string,
    tenantId: string,
    options: BatchOptions = {}
  ): Promise<BatchRemediationResult> {
    const batch = await this.getBatchStatus(batchId, tenantId);
    if (!batch) throw new Error('Batch not found');

    if (areQueuesAvailable()) {
      const queue = getBatchQueue();
      if (queue) {
        try {
          await queue.add(`batch-${batchId}`, {
            batchId,
            tenantId,
            options,
          }, {
            jobId: batchId,
          });

          batch.status = 'processing';
          batch.startedAt = new Date();
          await this.updateBatchStatus(batchId, batch);

          logger.info(`Batch ${batchId} queued for async processing`);
          return batch;
        } catch (err) {
          logger.error(`Failed to enqueue batch ${batchId}: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      }
    }

    batch.status = 'processing';
    batch.startedAt = new Date();
    await this.updateBatchStatus(batchId, batch);

    logger.info(`Batch ${batchId} processing synchronously (Redis not available)`);
    return this.processBatchSync(batchId, tenantId, options);
  }

  async processBatchSync(
    batchId: string,
    tenantId: string,
    options: BatchOptions = {}
  ): Promise<BatchRemediationResult> {
    const rawOutput = await this.getBatchStatus(batchId, tenantId);
    if (!rawOutput) {
      throw new Error('Batch not found');
    }

    const result = rawOutput as unknown as BatchRemediationResult;

    if (result.status === 'cancelled') {
      logger.info(`Batch ${batchId} was cancelled, skipping processing`);
      return result;
    }

    result.status = 'processing';
    await this.updateBatchStatus(batchId, result);

    for (let i = 0; i < result.jobs.length; i++) {
      const job = result.jobs[i];

      if (job.status === 'cancelled') {
        continue;
      }

      try {
        job.status = 'processing';
        job.startedAt = new Date();
        await this.updateBatchStatus(batchId, result);

        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'job_started',
          batchId,
          jobId: job.jobId,
          jobIndex: i,
          totalJobs: result.jobs.length,
        }, tenantId);
        logger.info(`[SSE] Broadcasting job_started for: ${job.jobId}`);

        const jobRecord = await prisma.job.findUnique({ where: { id: job.jobId } });
        if (!jobRecord) {
          throw new Error(`Job record not found: ${job.jobId}`);
        }

        const input = jobRecord.input as { fileName?: string } | null;
        const fileName = input?.fileName || 'upload.epub';

        // Update job.fileName to match for consistency in results
        job.fileName = fileName;

        const epubBuffer = await fileStorageService.getFile(job.jobId, fileName);
        if (!epubBuffer) {
          throw new Error(`EPUB file not found for job ${job.jobId}: ${fileName}`);
        }

        const remediationResult = await autoRemediationService.runAutoRemediation(
          epubBuffer,
          job.jobId,
          fileName
        );

        job.status = 'completed';
        job.issuesFixed = remediationResult.totalIssuesFixed;
        job.issuesFailed = remediationResult.totalIssuesFailed;
        job.completedAt = new Date();

        result.completedJobs++;
        result.summary.totalIssuesFixed += remediationResult.totalIssuesFixed;
        result.summary.totalIssuesFailed += remediationResult.totalIssuesFailed;

        if (options.generateComparison) {
          const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');
          const remediatedBuffer = await fileStorageService.getRemediatedFile(job.jobId, remediatedFileName);
          if (remediatedBuffer) {
            await epubComparisonService.compareEPUBs(
              epubBuffer,
              remediatedBuffer,
              job.jobId,
              fileName
            );
          }
        }

        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'job_completed',
          batchId,
          jobId: job.jobId,
          issuesFixed: job.issuesFixed,
          progress: Math.round(((i + 1) / result.jobs.length) * 100),
        }, tenantId);
        logger.info(`[SSE] Broadcasting job_completed for: ${job.jobId}`);

        logger.info(`Batch ${batchId}: Completed job ${job.jobId} (${i + 1}/${result.jobs.length})`);

      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';
        job.completedAt = new Date();
        result.failedJobs++;

        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'job_failed',
          batchId,
          jobId: job.jobId,
          error: job.error,
        }, tenantId);
        logger.info(`[SSE] Broadcasting job_failed for: ${job.jobId}`);

        logger.error(`Batch ${batchId}: Failed job ${job.jobId}`, error instanceof Error ? error : undefined);

        if (options.stopOnError) {
          result.status = 'failed';
          break;
        }
      }

      await this.updateBatchStatus(batchId, result);
    }

    result.status = result.failedJobs === result.totalJobs ? 'failed' : 'completed';
    result.completedAt = new Date();
    result.summary.successRate = result.totalJobs > 0
      ? Math.round((result.completedJobs / result.totalJobs) * 100)
      : 0;

    await this.updateBatchStatus(batchId, result);
    this.activeBatches.delete(batchId);

    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'batch_completed',
      batchId,
      status: result.status,
      summary: result.summary,
      completedJobs: result.completedJobs,
      failedJobs: result.failedJobs,
    }, tenantId);
    logger.info(`[SSE] Broadcasting batch_completed for: ${batchId}`);

    logger.info(`Batch ${batchId} completed: ${result.completedJobs}/${result.totalJobs} successful`);

    return result;
  }

  async getBatchStatus(batchId: string, tenantId: string): Promise<BatchRemediationResult | null> {
    if (this.activeBatches.has(batchId)) {
      return this.activeBatches.get(batchId)!;
    }

    const batchJob = await prisma.job.findFirst({
      where: {
        id: batchId,
        tenantId,
        type: 'BATCH_VALIDATION',
      },
    });

    if (!batchJob?.output) {
      return null;
    }

    const rawOutput = batchJob.output as Record<string, unknown> | null;
    if (!rawOutput || typeof rawOutput !== 'object' || !rawOutput.batchId || !rawOutput.jobs) {
      return null;
    }

    return {
      batchId: rawOutput.batchId as string,
      status: rawOutput.status as BatchStatus,
      totalJobs: rawOutput.totalJobs as number,
      completedJobs: rawOutput.completedJobs as number,
      failedJobs: rawOutput.failedJobs as number,
      jobs: rawOutput.jobs as BatchJob[],
      summary: rawOutput.summary as BatchRemediationResult['summary'],
      startedAt: rawOutput.startedAt as Date,
      completedAt: rawOutput.completedAt as Date | undefined,
      acrGenerated: rawOutput.acrGenerated as boolean | undefined,
      acrMode: rawOutput.acrMode as 'individual' | 'aggregate' | undefined,
      acrWorkflowIds: rawOutput.acrWorkflowIds as string[] | undefined,
      acrGeneratedAt: rawOutput.acrGeneratedAt as string | undefined,
      acrGenerationHistory: rawOutput.acrGenerationHistory as AcrGenerationHistoryEntry[] | undefined,
    };
  }

  async cancelBatch(batchId: string, tenantId: string): Promise<BatchRemediationResult> {
    const result = await this.getBatchStatus(batchId, tenantId);

    if (!result) {
      throw new Error('Batch not found');
    }

    if (result.status !== 'processing' && result.status !== 'pending') {
      throw new Error('Batch cannot be cancelled (already completed or failed)');
    }

    result.status = 'cancelled';
    result.completedAt = new Date();

    for (const job of result.jobs) {
      if (job.status === 'pending') {
        job.status = 'cancelled' as BatchStatus;
      }
    }

    await this.updateBatchStatus(batchId, result);
    this.activeBatches.delete(batchId);

    logger.info(`Batch ${batchId} cancelled`);

    return result;
  }

  async listBatches(
    tenantId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ batches: BatchRemediationResult[]; total: number }> {
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: {
          tenantId,
          type: 'BATCH_VALIDATION',
          input: {
            path: ['recordType'],
            equals: 'batch_remediation',
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.job.count({
        where: {
          tenantId,
          type: 'BATCH_VALIDATION',
          input: {
            path: ['recordType'],
            equals: 'batch_remediation',
          },
        },
      }),
    ]);

    const batches = jobs
      .filter(j => j.output)
      .map(j => j.output as unknown as BatchRemediationResult);

    return { batches, total };
  }

  async retryJob(
    batchId: string,
    jobId: string,
    tenantId: string,
    _options: BatchOptions = {}
  ): Promise<BatchJob> {
    const result = await this.getBatchStatus(batchId, tenantId);

    if (!result) {
      throw new Error('Batch not found');
    }

    const jobIndex = result.jobs.findIndex(j => j.jobId === jobId);
    if (jobIndex === -1) {
      throw new Error('Job not found in batch');
    }

    const job = result.jobs[jobIndex];
    if (job.status !== 'failed') {
      throw new Error('Only failed jobs can be retried');
    }

    job.status = 'processing';
    job.error = undefined;
    job.startedAt = new Date();
    job.completedAt = undefined;

    await this.updateBatchStatus(batchId, result);

    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'job_retry_started',
      batchId,
      jobId: job.jobId,
    }, tenantId);

    try {
      const jobRecord = await prisma.job.findUnique({ where: { id: job.jobId } });
      if (!jobRecord) throw new Error(`Job record not found: ${job.jobId}`);

      const input = jobRecord.input as { fileName?: string } | null;
      const fileName = input?.fileName || 'upload.epub';
      job.fileName = fileName;

      const epubBuffer = await fileStorageService.getFile(job.jobId, fileName);
      if (!epubBuffer) throw new Error(`EPUB file not found: ${fileName}`);

      const remediationResult = await autoRemediationService.runAutoRemediation(
        epubBuffer,
        job.jobId,
        fileName
      );

      job.status = 'completed';
      job.issuesFixed = remediationResult.totalIssuesFixed;
      job.issuesFailed = remediationResult.totalIssuesFailed;
      job.completedAt = new Date();
      result.failedJobs = Math.max(0, result.failedJobs - 1);
      result.completedJobs++;
      result.summary.totalIssuesFixed += remediationResult.totalIssuesFixed;

      sseService.broadcastToChannel(`batch:${batchId}`, {
        type: 'job_retry_completed',
        batchId,
        jobId: job.jobId,
        issuesFixed: job.issuesFixed,
      }, tenantId);

    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();
      result.failedJobs++;

      sseService.broadcastToChannel(`batch:${batchId}`, {
        type: 'job_retry_failed',
        batchId,
        jobId: job.jobId,
        error: job.error,
      }, tenantId);
    }

    result.summary.successRate = result.totalJobs > 0
      ? Math.round((result.completedJobs / result.totalJobs) * 100)
      : 0;

    await this.updateBatchStatus(batchId, result);
    return job;
  }

  private async updateBatchStatus(batchId: string, result: BatchRemediationResult): Promise<void> {
    const status = result.status === 'completed' ? JobStatus.COMPLETED
      : result.status === 'failed' ? JobStatus.FAILED
      : result.status === 'cancelled' ? JobStatus.CANCELLED
      : JobStatus.PROCESSING;

    await prisma.job.update({
      where: { id: batchId },
      data: {
        status,
        output: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        ...(result.completedAt && { completedAt: result.completedAt }),
      },
    });

    this.activeBatches.set(batchId, result);
  }
}

export const batchRemediationService = new BatchRemediationService();
