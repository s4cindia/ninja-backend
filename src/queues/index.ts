import { Queue, QueueEvents } from 'bullmq';
import { getRedisClient } from '../lib/redis.js';

export const QUEUE_NAMES = {
  ACCESSIBILITY: 'accessibility-validation',
  VPAT: 'vpat-generation',
  FILE_PROCESSING: 'file-processing',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

export const JOB_TYPES = {
  PDF_ACCESSIBILITY: 'PDF_ACCESSIBILITY',
  EPUB_ACCESSIBILITY: 'EPUB_ACCESSIBILITY',
  VPAT_GENERATION: 'VPAT_GENERATION',
  ALT_TEXT_GENERATION: 'ALT_TEXT_GENERATION',
  METADATA_EXTRACTION: 'METADATA_EXTRACTION',
  BATCH_VALIDATION: 'BATCH_VALIDATION',
} as const;

export type JobType = typeof JOB_TYPES[keyof typeof JOB_TYPES];

export interface JobData {
  type: JobType;
  tenantId: string;
  userId: string;
  fileId?: string;
  productId?: string;
  options?: Record<string, unknown>;
}

export interface JobResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

const connection = getRedisClient();

export const accessibilityQueue = new Queue<JobData, JobResult>(
  QUEUE_NAMES.ACCESSIBILITY,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 60 * 60,
      },
    },
  }
);

export const vpatQueue = new Queue<JobData, JobResult>(
  QUEUE_NAMES.VPAT,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 60 * 60,
      },
    },
  }
);

export const fileProcessingQueue = new Queue<JobData, JobResult>(
  QUEUE_NAMES.FILE_PROCESSING,
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60,
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 60 * 60,
      },
    },
  }
);

export const accessibilityQueueEvents = new QueueEvents(QUEUE_NAMES.ACCESSIBILITY, {
  connection,
});

export const vpatQueueEvents = new QueueEvents(QUEUE_NAMES.VPAT, {
  connection,
});

export const queues = {
  [QUEUE_NAMES.ACCESSIBILITY]: accessibilityQueue,
  [QUEUE_NAMES.VPAT]: vpatQueue,
  [QUEUE_NAMES.FILE_PROCESSING]: fileProcessingQueue,
};

export function getQueue(name: QueueName): Queue<JobData, JobResult> {
  return queues[name];
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    accessibilityQueue.close(),
    vpatQueue.close(),
    fileProcessingQueue.close(),
    accessibilityQueueEvents.close(),
    vpatQueueEvents.close(),
  ]);
}
