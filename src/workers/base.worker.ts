import { Job, Worker } from 'bullmq';
import { isRedisConfigured } from '../lib/redis';
import { getBullMQConnection, JobData, JobResult } from '../queues';
import { queueService } from '../services/queue.service';
import { logger } from '../lib/logger';

export type JobProcessor = (job: Job<JobData, JobResult>) => Promise<JobResult>;

export interface WorkerOptions {
  queueName: string;
  processor: JobProcessor;
  concurrency?: number;
}

export function createWorker(options: WorkerOptions): Worker<JobData, JobResult> | null {
  const { queueName, processor, concurrency = 1 } = options;

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

          logger.info(`Job ${jobId} completed successfully`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`Job ${jobId} failed: ${errorMessage}`);

          await queueService.updateJobStatus(jobId, 'FAILED', {
            error: errorMessage,
          });

          throw error;
        }
      },
      {
        connection,
        concurrency,
        autorun: true,
      }
    );

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
      logger.error(`Worker error: ${err.message}`);
    });

    return worker;
  } catch (error) {
    logger.warn(`Could not create worker for ${queueName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}
