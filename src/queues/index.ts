import { Queue, QueueEvents } from 'bullmq';
import { isRedisConfigured } from '../lib/redis';
import { getRedisUrl } from '../config/redis.config';
import { logger } from '../lib/logger';

// Queue prefix isolates queues per environment when multiple developers
// share the same Redis instance (e.g., Upstash). Each machine gets its own
// set of queues so workers don't steal jobs from other environments.
// Set QUEUE_PREFIX in .env to override (e.g., hostname for dev isolation).
// Defaults to 'bull' (BullMQ standard) to avoid orphaning existing queues.
const QUEUE_PREFIX = process.env.QUEUE_PREFIX || 'bull';

export { QUEUE_PREFIX };

export const QUEUE_NAMES = {
  ACCESSIBILITY: 'accessibility-validation',
  VPAT: 'vpat-generation',
  FILE_PROCESSING: 'file-processing',
  BATCH_REMEDIATION: 'batch-remediation',
  BATCH_PROCESSING: 'batch-processing',
  CITATION_PROCESSING: 'citation-processing',
  STYLE_PROCESSING: 'style-processing',
  CALIBRATION: 'calibration',
  AUTO_REMEDIATION: 'auto-remediation',
  PDF_BATCH_ITEM: 'pdf-batch-item',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

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
  CALIBRATION_RUN: 'CALIBRATION_RUN',
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

// Doesn't map onto the generic JobData/JobResult shape (same reasoning as
// Batch*JobData above) -- auto-remediation's user-visible state lives on
// ComparisonTrial/PdfAutoRemediationRun, not on the Job row the generic
// worker wrapper (createWorker) keeps in sync. The driver re-reads
// everything else it needs straight from Postgres, so the job payload is
// deliberately just enough to reconstruct the right driver.
export interface AutoRemediationJobData {
  kind: 'trial' | 'jobRun';
  id: string;
}

export interface AutoRemediationJobResult {
  kind: 'trial' | 'jobRun';
  id: string;
}

// One job per PdfBatchItem (not one per whole PdfBatch) -- each item's
// audit+remediate lifecycle is a natural unit of work, and this lets
// BullMQ's own worker `concurrency` give process-level fan-out on top of
// the DB-level weighted concurrency budget (concurrency-budget.service.ts)
// as the real cross-task admission control, instead of one giant job
// trying to internally run many hours-long concurrent tasks in a single
// event loop. Minimal payload, same reasoning as AutoRemediationJobData --
// the orchestrator re-reads everything else from Postgres.
export interface PdfBatchItemJobData {
  batchId: string;
  itemId: string;
}

export interface PdfBatchItemJobResult {
  batchId: string;
  itemId: string;
}

interface BullMQConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
  connectTimeout: number;
  keepAlive: number;
  retryStrategy: (times: number) => number | null;
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
    // Give TLS handshakes 10 s before declaring a timeout
    connectTimeout: 10_000,
    // Send TCP keepalive every 30 s so cloud providers (Upstash, ElastiCache)
    // don't silently drop idle connections
    keepAlive: 30_000,
    // Jittered exponential back-off prevents all workers from thundering-herd
    // reconnecting simultaneously after a shared connection drop.
    // Times out permanently after 20 attempts (~3 min total).
    retryStrategy: (times: number) => {
      if (times > 20) return null;
      const jitter = Math.floor(Math.random() * 500);
      return Math.min(times * 500, 10_000) + jitter;
    },
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
let _citationQueue: Queue<JobData, JobResult> | null = null;
let _styleQueue: Queue<JobData, JobResult> | null = null;
let _calibrationQueue: Queue<JobData, JobResult> | null = null;
let _autoRemediationQueue: Queue<AutoRemediationJobData, AutoRemediationJobResult> | null = null;
let _pdfBatchItemQueue: Queue<PdfBatchItemJobData, PdfBatchItemJobResult> | null = null;
let _accessibilityQueueEvents: QueueEvents | null = null;
let _vpatQueueEvents: QueueEvents | null = null;
let _fileProcessingQueueEvents: QueueEvents | null = null;
let _citationQueueEvents: QueueEvents | null = null;
let _styleQueueEvents: QueueEvents | null = null;
let _calibrationQueueEvents: QueueEvents | null = null;
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

  const prefix = QUEUE_PREFIX;

  _accessibilityQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.ACCESSIBILITY,
    { connection, defaultJobOptions, prefix }
  );

  _vpatQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.VPAT,
    { connection, defaultJobOptions, prefix }
  );

  _fileProcessingQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.FILE_PROCESSING,
    { connection, defaultJobOptions, prefix }
  );

  _batchQueue = new Queue<BatchJobData, BatchJobResult>(
    QUEUE_NAMES.BATCH_REMEDIATION,
    { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 }, prefix }
  );

  // attempts: 1, same as BATCH_REMEDIATION above -- startAutoLoop never
  // throws (it catches its own errors and always writes a terminal state
  // before resolving), so BullMQ's retry path only fires if the worker
  // process itself dies mid-run, and at that point reconcileIfOrphaned/
  // reconcileIfOrphanedJobRun already handle recovery correctly.
  _autoRemediationQueue = new Queue<AutoRemediationJobData, AutoRemediationJobResult>(
    QUEUE_NAMES.AUTO_REMEDIATION,
    { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 }, prefix }
  );

  _batchProcessingQueue = new Queue<BatchProcessingJobData, BatchProcessingJobResult>(
    QUEUE_NAMES.BATCH_PROCESSING,
    {
      connection,
      prefix,
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

  // attempts: 1 -- the orchestrator's own processor catches its own errors
  // and marks the PdfBatchItem FAILED (releasing any held lease) rather than
  // rethrowing in the ordinary failure case; a silent BullMQ-level retry
  // would re-acquire leases and re-run expensive AI work against an item
  // Postgres already shows as terminally FAILED. If the worker process
  // itself dies mid-item, reconcileStaleLeases's heartbeat-based staleness
  // check is the recovery path, not a BullMQ retry.
  _pdfBatchItemQueue = new Queue<PdfBatchItemJobData, PdfBatchItemJobResult>(
    QUEUE_NAMES.PDF_BATCH_ITEM,
    { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 }, prefix }
  );

  _accessibilityQueueEvents = new QueueEvents(QUEUE_NAMES.ACCESSIBILITY, {
    connection, prefix,
  });

  _vpatQueueEvents = new QueueEvents(QUEUE_NAMES.VPAT, {
    connection, prefix,
  });

  _fileProcessingQueueEvents = new QueueEvents(QUEUE_NAMES.FILE_PROCESSING, {
    connection, prefix,
  });

  _citationQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.CITATION_PROCESSING,
    { connection, defaultJobOptions, prefix }
  );

  _citationQueueEvents = new QueueEvents(QUEUE_NAMES.CITATION_PROCESSING, {
    connection, prefix,
  });

  _styleQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.STYLE_PROCESSING,
    { connection, defaultJobOptions, prefix }
  );

  _styleQueueEvents = new QueueEvents(QUEUE_NAMES.STYLE_PROCESSING, {
    connection, prefix,
  });

  _calibrationQueue = new Queue<JobData, JobResult>(
    QUEUE_NAMES.CALIBRATION,
    { connection, defaultJobOptions, prefix }
  );

  _calibrationQueueEvents = new QueueEvents(QUEUE_NAMES.CALIBRATION, {
    connection, prefix,
  });

  _initialized = true;
  logger.info(`📦 BullMQ queues initialized (prefix: "${prefix}")`);
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

export function getBatchProcessingQueue(): Queue<BatchProcessingJobData, BatchProcessingJobResult> | null {
  ensureQueuesInitialized();
  return _batchProcessingQueue;
}

export function getPdfBatchItemQueue(): Queue<PdfBatchItemJobData, PdfBatchItemJobResult> | null {
  ensureQueuesInitialized();
  return _pdfBatchItemQueue;
}

export function getAutoRemediationQueue(): Queue<AutoRemediationJobData, AutoRemediationJobResult> | null {
  ensureQueuesInitialized();
  return _autoRemediationQueue;
}

export function getCitationQueue(): Queue<JobData, JobResult> | null {
  ensureQueuesInitialized();
  return _citationQueue;
}

export function getStyleQueue(): Queue<JobData, JobResult> | null {
  ensureQueuesInitialized();
  return _styleQueue;
}

export function getCalibrationQueue(): Queue<JobData, JobResult> | null {
  ensureQueuesInitialized();
  return _calibrationQueue;
}

export function getQueue(name: QueueName): Queue<JobData, JobResult> {
  switch (name) {
    case QUEUE_NAMES.ACCESSIBILITY:
      return getAccessibilityQueue();
    case QUEUE_NAMES.VPAT:
      return getVpatQueue();
    case QUEUE_NAMES.FILE_PROCESSING:
      return getFileProcessingQueue();
    case QUEUE_NAMES.CITATION_PROCESSING: {
      const citationQueue = getCitationQueue();
      if (!citationQueue) throw new Error('Citation queue not available - Redis not configured');
      return citationQueue;
    }
    case QUEUE_NAMES.STYLE_PROCESSING: {
      const styleQueue = getStyleQueue();
      if (!styleQueue) throw new Error('Style queue not available - Redis not configured');
      return styleQueue;
    }
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
  if (_autoRemediationQueue) closePromises.push(_autoRemediationQueue.close());
  if (_pdfBatchItemQueue) closePromises.push(_pdfBatchItemQueue.close());
  if (_citationQueue) closePromises.push(_citationQueue.close());
  if (_styleQueue) closePromises.push(_styleQueue.close());
  if (_calibrationQueue) closePromises.push(_calibrationQueue.close());
  if (_accessibilityQueueEvents) closePromises.push(_accessibilityQueueEvents.close());
  if (_vpatQueueEvents) closePromises.push(_vpatQueueEvents.close());
  if (_fileProcessingQueueEvents) closePromises.push(_fileProcessingQueueEvents.close());
  if (_citationQueueEvents) closePromises.push(_citationQueueEvents.close());
  if (_styleQueueEvents) closePromises.push(_styleQueueEvents.close());
  if (_calibrationQueueEvents) closePromises.push(_calibrationQueueEvents.close());

  await Promise.all(closePromises);

  _accessibilityQueue = null;
  _vpatQueue = null;
  _fileProcessingQueue = null;
  _batchQueue = null;
  _batchProcessingQueue = null;
  _autoRemediationQueue = null;
  _pdfBatchItemQueue = null;
  _citationQueue = null;
  _styleQueue = null;
  _calibrationQueue = null;
  _accessibilityQueueEvents = null;
  _vpatQueueEvents = null;
  _fileProcessingQueueEvents = null;
  _citationQueueEvents = null;
  _styleQueueEvents = null;
  _calibrationQueueEvents = null;
  _initialized = false;
}
