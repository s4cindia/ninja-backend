import { Worker } from 'bullmq';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, JobData, JobResult } from '../queues';
import { processAccessibilityJob } from './processors/accessibility.processor';
import { processVpatJob } from './processors/vpat.processor';
import { processFileJob } from './processors/file.processor';

let workers: Worker<JobData, JobResult>[] = [];

export function startWorkers(): void {
  console.log('🚀 Starting job workers...');

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

  if (workers.length > 0) {
    console.log(`✅ ${workers.length} workers started`);
  } else {
    console.log('⚠️  No workers started (Redis may not be configured)');
  }
}

export async function stopWorkers(): Promise<void> {
  console.log('🛑 Stopping workers...');
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  console.log('✅ All workers stopped');
}

export function getActiveWorkers(): number {
  return workers.length;
}
