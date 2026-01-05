import { Job, Worker } from 'bullmq';
import { isRedisConfigured } from '../lib/redis';
import { getBullMQConnection, JobData, JobResult } from '../queues';
import { queueService } from '../services/queue.service';
import prisma from '../lib/prisma';

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
    const connection = getBullMQConnection();
    
    if (!connection) {
      console.warn(`⚠️  Cannot create worker for ${queueName} - Redis connection not available`);
      return null;
    }

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

          // Update file status to PROCESSED if job has a fileId
          if (job.data.fileId) {
            try {
              await prisma.file.update({
                where: { id: job.data.fileId },
                data: { status: 'PROCESSED' }
              });
              console.log(`📁 File ${job.data.fileId} status updated to PROCESSED`);
            } catch (fileError) {
              console.error(`⚠️ Could not update file status:`, fileError);
            }
          }

          console.log(`✅ Job ${jobId} completed successfully`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`❌ Job ${jobId} failed:`, errorMessage);

          await queueService.updateJobStatus(jobId, 'FAILED', {
            error: errorMessage,
          });

          // Update file status to ERROR if job has a fileId
          if (job.data.fileId) {
            try {
              await prisma.file.update({
                where: { id: job.data.fileId },
                data: { status: 'ERROR' }
              });
              console.log(`📁 File ${job.data.fileId} status updated to ERROR`);
            } catch (fileError) {
              console.error(`⚠️ Could not update file status:`, fileError);
            }
          }

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
