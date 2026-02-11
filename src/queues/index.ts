import { Queue, QueueEvents } from 'bullmq';
import { isRedisConfigured } from '../lib/redis';
import { getRedisUrl } from '../config/redis.config';
import { logger } from '../lib/logger';

export const QUEUE_NAMES = {
  ACCESSIBILITY: 'accessibility-validation',
  VPAT: 'vpat-generation',
  FILE_PROCESSING: 'file-processing',
  BATCH_REMEDIATION: 'batch-remediation',
  BATCH_PROCESSING: 'batch-processing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_TYPES = {
  PDF_ACCESSIBILITY: 'PDF_ACCESSIBILITY',
  EPUB_ACCESSIBILITY: 'EPUB_ACCESSIBILITY',
  VPAT_GENERATION: 'VPAT_GENERATION',
  ALT_TEXT_GENERATION: 'ALT_TEXT_GENERATION',
  METADATA_EXTRACTION: 'METADATA_EXTRACTION',
  BATCH_VALIDATION: 'BATCH_VALIDATION',
  ACR_WORKFLOW: 'ACR_WORKFLOW',
  PLAGIARISM_CHECK: 'PLAGIARISM_CHECK',
  CITATION_VALIDATION: 'CITATION_VALIDATION',
  CITATION_DETECTION: 'CITATION_DETECTION',
  STYLE_VALIDATION: 'STYLE_VALIDATION',
  EDITORIAL_FULL: 'EDITORIAL_FULL',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

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

export interface BatchJobData {
  batchId: string;
  tenantId: string;
  options: {
    fixCodes?: string[];
    stopOnError?: boolean;
    generateComparison?: boolean;
  };
}

export interface BatchJobResult {
  batchId: string;
  completedJobs: number;
  failedJobs: number;
  totalIssuesFixed: number;
}

export interface BatchProcessingJobData {
  batchId: string;
  tenantId: string;
}

export interface BatchProcessingJobResult {
  batchId: string;
  filesProcessed: number;
  filesRemediated: number;
  filesFailed: number;
}

interface BullMQConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
  tls?: {
    rejectUnauthorized: boolean;
  };
}

function getBullMQConnection(): BullMQConnectionOptions | null {
  const redisUrl = getRedisUrl();

  if (!redisUrl) {
    return null;
  }

  const useTls = redisUrl.startsWith('rediss://') || redisUrl.includes('upstash');
  let connectionUrl = redisUrl;

  if (redisUrl.startsWith('rediss://')) {
    connectionUrl = redisUrl.replace('rediss://', 'redis://');
  }

  const url = new URL(connectionUrl);

  const options: BullMQConnectionOptions = {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (useTls) {
    options.tls = {
      rejectUnauthorized: false,
    };
  }

  return options;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
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
};

let _accessibilityQueue: Queue<JobData, JobResult> | null = null;
let _vpatQueue: Queue<JobData, JobResult> | null = null;
let _fileProcessingQueue: Queue<JobData, JobResult> | null = null;
let _batchQueue: Queue<BatchJobData, BatchJobResult> | null = null;
let _batchProcessingQueue: Queue<BatchProcessingJobData, BatchProcessingJobResult> | null = null;
let _accessibilityQueueEvents: QueueEvents | null = null;
let _vpatQueueEvents: QueueEvents | null = null;
let _fileProcessingQueueEvents: QueueEvents | null = null;
let _initialized = false;

function ensureQueuesInitialized(): void {
  if (_initialized) return;

  if (!isRedisConfigured()) {
    logger.warn('⚠️  Redis not configured - queues will not be available');
    return;
  }

  const connection = getBullMQConnection();
  if (!connection) {
    logger.warn('⚠️  Could not create Redis connection - queues will not be available');
    return;
  }

  _accessibilityQueue = new Queue<JobData, JobResult>(QUEUE_NAMES.ACCESSIBILITY, {
    connection,
    defaultJobOptions,
  });

  _vpatQueue = new Queue<JobData, JobResult>(QUEUE_NAMES.VPAT, { connection, defaultJobOptions });

  _fileProcessingQueue = new Queue<JobData, JobResult>(QUEUE_NAMES.FILE_PROCESSING, {
    connection,
    defaultJobOptions,
  });

  _batchQueue = new Queue<BatchJobData, BatchJobResult>(QUEUE_NAMES.BATCH_REMEDIATION, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
  });

  _batchProcessingQueue = new Queue<BatchProcessingJobData, BatchProcessingJobResult>(
    QUEUE_NAMES.BATCH_PROCESSING,
    {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: 24 * 60 * 60,
          count: 100,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
        },
      },
    }
  );

  _accessibilityQueueEvents = new QueueEvents(QUEUE_NAMES.ACCESSIBILITY, {
    connection,
  });

  _vpatQueueEvents = new QueueEvents(QUEUE_NAMES.VPAT, {
    connection,
  });

  _fileProcessingQueueEvents = new QueueEvents(QUEUE_NAMES.FILE_PROCESSING, {
    connection,
  });

  _initialized = true;
  logger.info('📦 BullMQ queues initialized with TLS support');
}

export function getAccessibilityQueue(): Queue<JobData, JobResult> {
  ensureQueuesInitialized();
  if (!_accessibilityQueue) {
    throw new Error('Queues not available - Redis not configured');
  }
  return _accessibilityQueue;
}

export function getVpatQueue(): Queue<JobData, JobResult> {
  ensureQueuesInitialized();
  if (!_vpatQueue) {
    throw new Error('Queues not available - Redis not configured');
  }
  return _vpatQueue;
}

export function getFileProcessingQueue(): Queue<JobData, JobResult> {
  ensureQueuesInitialized();
  if (!_fileProcessingQueue) {
    throw new Error('Queues not available - Redis not configured');
  }
  return _fileProcessingQueue;
}

export function getBatchQueue(): Queue<BatchJobData, BatchJobResult> | null {
  ensureQueuesInitialized();
  return _batchQueue;
}

export function getBatchProcessingQueue(): Queue<
  BatchProcessingJobData,
  BatchProcessingJobResult
> | null {
  ensureQueuesInitialized();
  return _batchProcessingQueue;
}

export function getQueue(name: QueueName): Queue<JobData, JobResult> {
  switch (name) {
    case QUEUE_NAMES.ACCESSIBILITY:
      return getAccessibilityQueue();
    case QUEUE_NAMES.VPAT:
      return getVpatQueue();
    case QUEUE_NAMES.FILE_PROCESSING:
      return getFileProcessingQueue();
    default:
      throw new Error(`Unknown queue: ${name}`);
  }
}

export function areQueuesAvailable(): boolean {
  return isRedisConfigured();
}

export { getBullMQConnection };

export async function closeQueues(): Promise<void> {
  if (!_initialized) return;

  const closePromises: Promise<void>[] = [];

  if (_accessibilityQueue) closePromises.push(_accessibilityQueue.close());
  if (_vpatQueue) closePromises.push(_vpatQueue.close());
  if (_fileProcessingQueue) closePromises.push(_fileProcessingQueue.close());
  if (_batchQueue) closePromises.push(_batchQueue.close());
  if (_batchProcessingQueue) closePromises.push(_batchProcessingQueue.close());
  if (_accessibilityQueueEvents) closePromises.push(_accessibilityQueueEvents.close());
  if (_vpatQueueEvents) closePromises.push(_vpatQueueEvents.close());
  if (_fileProcessingQueueEvents) closePromises.push(_fileProcessingQueueEvents.close());

  await Promise.all(closePromises);

  _accessibilityQueue = null;
  _vpatQueue = null;
  _fileProcessingQueue = null;
  _batchQueue = null;
  _batchProcessingQueue = null;
  _accessibilityQueueEvents = null;
  _vpatQueueEvents = null;
  _fileProcessingQueueEvents = null;
  _initialized = false;
}
