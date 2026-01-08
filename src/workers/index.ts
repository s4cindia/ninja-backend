import { Worker } from 'bullmq';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, BatchJobData, BatchJobResult, getBullMQConnection } from '../queues';
import { processAccessibilityJob } from './processors/accessibility.processor';
import { processVpatJob } from './processors/vpat.processor';
import { processFileJob } from './processors/file.processor';
import { processBatchJob } from './processors/batch.processor';
import { isRedisConfigured } from '../lib/redis';
import { logger } from '../lib/logger';

let workers: Worker[] = [];

export function startWorkers(): void {
  logger.info('🚀 Starting job workers...');

  const accessibilityWorker = createWorker({
    queueName: QUEUE_NAMES.ACCESSIBILITY,
    processor: processAccessibilityJob,
    concurrency: 2,
  });
  if (accessibilityWorker) workers.push(accessibilityWorker);

  const vpatWorker = createWorker({
    queueName: QUEUE_NAMES.VPAT,
    processor: processVpatJob,
    concurrency: 1,
  });
  if (vpatWorker) workers.push(vpatWorker);

  const fileWorker = createWorker({
    queueName: QUEUE_NAMES.FILE_PROCESSING,
    processor: processFileJob,
    concurrency: 2,
  });
  if (fileWorker) workers.push(fileWorker);

  if (isRedisConfigured()) {
    const connection = getBullMQConnection();
    if (connection) {
      const batchWorker = new Worker<BatchJobData, BatchJobResult>(
        QUEUE_NAMES.BATCH_REMEDIATION,
        processBatchJob,
        { connection, concurrency: 1, autorun: true }
      );
      batchWorker.on('completed', (job) => {
        logger.info(`📗 Batch job ${job.id} completed`);
      });
      batchWorker.on('failed', (job, err) => {
        logger.error(`📕 Batch job ${job?.id} failed: ${err.message}`);
      });
      workers.push(batchWorker);
    }
  }

  if (workers.length > 0) {
    logger.info(`✅ ${workers.length} workers started`);
  } else {
    logger.warn('⚠️  No workers started (Redis may not be configured)');
  }
}

export async function stopWorkers(): Promise<void> {
  logger.info('🛑 Stopping workers...');
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  logger.info('✅ All workers stopped');
}

export function getActiveWorkers(): number {
  return workers.length;
}
