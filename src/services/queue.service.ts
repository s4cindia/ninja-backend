import { Queue } from 'bullmq';
import { Prisma, JobStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { 
  getAccessibilityQueue, 
  getVpatQueue, 
  getFileProcessingQueue,
  areQueuesAvailable,
  JobData, 
  JobResult,
  JOB_TYPES,
  JobType,
} from '../queues';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { logger } from '../lib/logger';

export interface CreateJobInput {
  type: JobType;
  tenantId: string;
  userId: string;
  fileId?: string;
  productId?: string;
  priority?: number;
  options?: Record<string, unknown>;
}

interface JobUpdateData {
  status: JobStatus;
  startedAt?: Date;
  completedAt?: Date;
  output?: Prisma.InputJsonValue;
  error?: string;
}

function getQueueForJobType(type: JobType): Queue<JobData, JobResult> | null {
  switch (type) {
    case JOB_TYPES.PDF_ACCESSIBILITY:
    case JOB_TYPES.EPUB_ACCESSIBILITY:
    case JOB_TYPES.BATCH_VALIDATION:
      return getAccessibilityQueue();
    case JOB_TYPES.VPAT_GENERATION:
      return getVpatQueue();
    case JOB_TYPES.ALT_TEXT_GENERATION:
    case JOB_TYPES.METADATA_EXTRACTION:
      return getFileProcessingQueue();
    case JOB_TYPES.ACR_WORKFLOW:
    case JOB_TYPES.PLAGIARISM_CHECK:
    case JOB_TYPES.CITATION_VALIDATION:
    case JOB_TYPES.CITATION_DETECTION:
    case JOB_TYPES.STYLE_VALIDATION:
    case JOB_TYPES.EDITORIAL_FULL:
      return null;
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown job type: ${exhaustiveCheck}`);
    }
  }
}

export class QueueService {
  async createJob(input: CreateJobInput): Promise<string> {
    const { type, tenantId, userId, fileId, productId, priority = 0, options } = input;

    if (!areQueuesAvailable()) {
      throw AppError.serviceUnavailable('Queue service not available - Redis not configured');
    }

    const inputData: Record<string, unknown> = { ...(options ?? {}) };
    if (fileId) {
      inputData.fileId = fileId;
    }

    const dbJob = await prisma.job.create({
      data: {
        type,
        status: 'QUEUED',
        priority,
        input: inputData as Prisma.InputJsonValue,
        tenantId,
        userId,
        productId,
      },
    });

    const jobData: JobData = {
      type,
      tenantId,
      userId,
      fileId,
      productId,
      options,
    };

    try {
      const queue = getQueueForJobType(type);
      if (!queue) {
        await prisma.job.update({
          where: { id: dbJob.id },
          data: { 
            status: 'CANCELLED',
            output: { message: `Queue processor not yet implemented for job type: ${type}. Job requires dedicated queue implementation.` } as Prisma.InputJsonValue,
          },
        });
        logger.warn(`📋 Job ${dbJob.id} created with CANCELLED status - no queue processor for: ${type}`);
        return dbJob.id;
      }
      await queue.add(type, jobData, {
        jobId: dbJob.id,
        priority,
      });

      logger.info(`📋 Job ${dbJob.id} added to queue: ${type}`);
      return dbJob.id;
    } catch (queueError) {
      await prisma.job.update({
        where: { id: dbJob.id },
        data: { status: 'FAILED', error: 'Failed to enqueue job' },
      });
      throw queueError;
    }
  }

  async getJobStatus(jobId: string, tenantId: string) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
      select: {
        id: true,
        type: true,
        status: true,
        progress: true,
        output: true,
        error: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });

    if (!job) {
      throw AppError.notFound('Job not found', ErrorCodes.JOB_NOT_FOUND);
    }

    return job;
  }

  async cancelJob(jobId: string, tenantId: string): Promise<void> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });

    if (!job) {
      throw AppError.notFound('Job not found', ErrorCodes.JOB_NOT_FOUND);
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      throw AppError.badRequest('Cannot cancel completed or failed job', ErrorCodes.JOB_CANNOT_CANCEL);
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'CANCELLED' },
    });

    if (areQueuesAvailable()) {
      try {
        const queue = getQueueForJobType(job.type as Parameters<typeof getQueueForJobType>[0]);
        if (queue) {
          const queueJob = await queue.getJob(jobId);
          if (queueJob) {
            await queueJob.remove();
          }
        }
      } catch (err) {
        logger.error('Failed to remove job from queue:', err as Error);
      }
    }
  }

  async updateJobProgress(jobId: string, progress: number): Promise<void> {
    await prisma.job.update({
      where: { id: jobId },
      data: { progress },
    });
  }

  async updateJobStatus(
    jobId: string, 
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED',
    data?: { output?: Record<string, unknown>; error?: string }
  ): Promise<void> {
    const updateData: JobUpdateData = { status: status as JobStatus };

    if (status === 'PROCESSING') {
      updateData.startedAt = new Date();
    } else if (status === 'COMPLETED' || status === 'FAILED') {
      updateData.completedAt = new Date();
    }

    if (data?.output) {
      updateData.output = data.output as Prisma.InputJsonValue;
    }

    if (data?.error) {
      updateData.error = data.error;
    }

    await prisma.job.update({
      where: { id: jobId },
      data: updateData,
    });
  }
}

export const queueService = new QueueService();
