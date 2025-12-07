import { Job, Worker } from 'bullmq';
import { getRedisClient, isRedisConfigured } from '../lib/redis';
import { queueService } from '../services/queue.service';
import { JobData, JobResult } from '../queues';

export type JobProcessor = (job: Job<JobData, JobResult>) => Promise<JobResult>;

export interface WorkerOptions {
  queueName: string;
  processor: JobProcessor;
  concurrency?: number;
}

export function createWorker(options: WorkerOptions): Worker<JobData, JobResult> | null {
  const { queueName, processor, concurrency = 1 } = options;

  if (!isRedisConfigured()) {
    console.warn(`⚠️  Cannot create worker for ${queueName} - Redis not configured`);
    return null;
  }

  try {
    const connection = getRedisClient();

    const worker = new Worker<JobData, JobResult>(
      queueName,
      async (job: Job<JobData, JobResult>) => {
        const jobId = job.id || job.name;
        console.log(`🔧 Processing job ${jobId}: ${job.data.type}`);

        try {
          await queueService.updateJobStatus(jobId, 'PROCESSING');

          const result = await processor(job);

          await queueService.updateJobStatus(jobId, 'COMPLETED', {
            output: result.data,
          });

          console.log(`✅ Job ${jobId} completed successfully`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`❌ Job ${jobId} failed:`, errorMessage);

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
      console.log(`📗 Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(`📕 Job ${job?.id} failed:`, err.message);
    });

    worker.on('progress', (job, progress) => {
      console.log(`📊 Job ${job.id} progress: ${progress}%`);
    });

    worker.on('error', (err) => {
      console.error('Worker error:', err);
    });

    return worker;
  } catch (error) {
    console.warn(`⚠️  Could not create worker for ${queueName}:`, error);
    return null;
  }
}
