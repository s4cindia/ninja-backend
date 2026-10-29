import { Job, Worker } from 'bullmq';
import { isRedisConfigured } from '../lib/redis';
import { getBullMQConnection, JobData, JobResult, QUEUE_PREFIX } from '../queues';
import { queueService } from '../services/queue.service';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';
import { FileStatus } from '@prisma/client';
import { notificationService } from '../services/notification/notification.service';

// Human-readable label per JobType, for the failure notification's title --
// deliberately local/minimal (just the types that reach this generic worker
// in practice) rather than importing JOB_TYPES, to avoid this file needing
// to track every job type the rest of the app ever adds.
const JOB_TYPE_LABELS: Record<string, string> = {
  PDF_ACCESSIBILITY: 'PDF accessibility job',
  EPUB_ACCESSIBILITY: 'EPUB accessibility job',
};

export type JobProcessor = (job: Job<JobData, JobResult>) => Promise<JobResult>;

export interface WorkerOptions {
  queueName: string;
  processor: JobProcessor;
  concurrency?: number;
  /** BullMQ lock duration in ms. Increase for long-running jobs (default: 30000). */
  lockDuration?: number;
  /**
   * How often BullMQ checks for stalled jobs in ms (default: 30000).
   * Lower values detect orphaned active jobs from crashed/restarted workers faster.
   */
  stalledInterval?: number;
}

export function createWorker(options: WorkerOptions): Worker<JobData, JobResult> | null {
  const { queueName, processor, concurrency = 1, lockDuration = 30000, stalledInterval = 30000 } = options;

  if (!isRedisConfigured()) {
    logger.warn(`Cannot create worker for ${queueName} - Redis not configured`);
    return null;
  }

  try {
    const connection = getBullMQConnection();
    
    if (!connection) {
      logger.warn(`Cannot create worker for ${queueName} - Redis connection not available`);
      return null;
    }

    const worker = new Worker<JobData, JobResult>(
      queueName,
      async (job: Job<JobData, JobResult>) => {
        const jobId = job.id || job.name;
        logger.info(`Processing job ${jobId}: ${job.data.type}`);

        try {
          await queueService.updateJobStatus(jobId, 'PROCESSING');

          const result = await processor(job);

          await queueService.updateJobStatus(jobId, 'COMPLETED', {
            output: result.data,
          });

          // Jobs enqueued from a two-step upload (upload → fileId → audit,
          // e.g. auditFromFileId) carry the originating File record's ID so
          // its status tracks the job outcome, same as direct-buffer uploads.
          if (job.data.fileId) {
            await prisma.file.update({
              where: { id: job.data.fileId },
              data: { status: FileStatus.PROCESSED },
            }).catch(() => {});
          }

          logger.info(`Job ${jobId} completed successfully`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`Job ${jobId} failed: ${errorMessage}`);

          await queueService.updateJobStatus(jobId, 'FAILED', {
            error: errorMessage,
          });

          // Fire-and-forget: the operator's own notification bell/toast,
          // not something the (already-failed) job should wait on or be
          // further broken by a notification-write hiccup. Only PDF jobs
          // have a results page to link to today; other types still notify,
          // just without a link.
          const jobOptions = job.data.options as { dbJobId?: string } | undefined;
          const linkJobId = job.data.type === 'PDF_ACCESSIBILITY' ? (jobOptions?.dbJobId ?? jobId) : undefined;
          notificationService.createNotification({
            userId: job.data.userId,
            tenantId: job.data.tenantId,
            type: 'JOB_FAILED',
            title: `${JOB_TYPE_LABELS[job.data.type] ?? 'Job'} failed`,
            message: errorMessage,
            link: linkJobId ? `/pdf/audit/${linkJobId}` : undefined,
          }).catch((notifyErr) => {
            logger.error(`Failed to create failure notification for job ${jobId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
          });

          if (job.data.fileId) {
            await prisma.file.update({
              where: { id: job.data.fileId },
              data: { status: FileStatus.ERROR },
            }).catch(() => {});
          }

          throw error;
        }
      },
      {
        connection,
        concurrency,
        autorun: true,
        prefix: QUEUE_PREFIX,
        lockDuration,
        stalledInterval,
      }
    );

    worker.on('ready', () => {
      logger.info(`Worker for ${queueName} is ready and connected to Redis`);
    });

    worker.on('drained', () => {
      logger.debug(`Worker for ${queueName} queue is empty — waiting for jobs`);
    });

    worker.on('active', (job) => {
      logger.info(`Worker [${queueName}] picked up job ${job.id} — BullMQ is processing`);
    });

    worker.on('completed', (job) => {
      logger.info(`Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`Job ${job?.id} failed: ${err.message}`);
    });

    worker.on('progress', (job, progress) => {
      logger.debug(`Job ${job.id} progress: ${progress}%`);
    });

    worker.on('error', (err) => {
      logger.error(`Worker [${queueName}] error: ${err.message}`, { stack: err.stack });
    });

    return worker;
  } catch (error) {
    logger.warn(`Could not create worker for ${queueName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}
