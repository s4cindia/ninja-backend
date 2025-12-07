import { Job } from 'bullmq';
import { prisma } from '../lib/prisma';
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

export interface CreateJobInput {
  type: JobType;
  tenantId: string;
  userId: string;
  fileId?: string;
  productId?: string;
  priority?: number;
  options?: Record<string, unknown>;
}

export class QueueService {
  async createJob(input: CreateJobInput): Promise<string> {
    const { type, tenantId, userId, fileId, productId, priority = 0, options } = input;

    if (!areQueuesAvailable()) {
      throw AppError.serviceUnavailable('Queue service not available - Redis not configured');
    }

    const dbJob = await prisma.job.create({
      data: {
        type,
        status: 'QUEUED',
        priority,
        input: options || {},
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

    let queueJob: Job<JobData, JobResult>;

    switch (type) {
      case JOB_TYPES.PDF_ACCESSIBILITY:
      case JOB_TYPES.EPUB_ACCESSIBILITY:
      case JOB_TYPES.BATCH_VALIDATION:
        queueJob = await getAccessibilityQueue().add(type, jobData, {
          jobId: dbJob.id,
          priority,
        });
        break;

      case JOB_TYPES.VPAT_GENERATION:
        queueJob = await getVpatQueue().add(type, jobData, {
          jobId: dbJob.id,
          priority,
        });
        break;

      case JOB_TYPES.ALT_TEXT_GENERATION:
      case JOB_TYPES.METADATA_EXTRACTION:
        queueJob = await getFileProcessingQueue().add(type, jobData, {
          jobId: dbJob.id,
          priority,
        });
        break;

      default:
        throw AppError.badRequest(`Unknown job type: ${type}`);
    }

    console.log(`📋 Job ${dbJob.id} added to queue: ${type}`);
    return dbJob.id;
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
        const queueJob = await getAccessibilityQueue().getJob(jobId);
        if (queueJob) {
          await queueJob.remove();
        }
      } catch (err) {
        console.error('Failed to remove job from queue:', err);
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
    const updateData: Record<string, unknown> = { status };

    if (status === 'PROCESSING') {
      updateData.startedAt = new Date();
    } else if (status === 'COMPLETED' || status === 'FAILED') {
      updateData.completedAt = new Date();
    }

    if (data?.output) {
      updateData.output = data.output;
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
