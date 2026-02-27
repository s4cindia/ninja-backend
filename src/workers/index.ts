import { Worker } from 'bullmq';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, QUEUE_PREFIX, BatchJobData, BatchJobResult, BatchProcessingJobData, BatchProcessingJobResult, getBullMQConnection, getCitationQueue, JOB_TYPES, areQueuesAvailable } from '../queues';
import { processAccessibilityJob } from './processors/accessibility.processor';
import { processVpatJob } from './processors/vpat.processor';
import { processFileJob } from './processors/file.processor';
import { processBatchJob } from './processors/batch.processor';
import { processBatchProcessingJob } from './processors/batch-processing.processor';
import { processCitationJob } from './processors/citation.processor';
import { startWorkflowWorker } from '../queues/workflow.queue';
import { processStyleJob } from './processors/style.processor';
import { isRedisConfigured } from '../lib/redis';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';

let workers: Worker[] = [];
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let isRecovering = false;

// How often the watchdog checks for stuck jobs (3 minutes)
const WATCHDOG_INTERVAL_MS = 3 * 60 * 1000;
// How long a job must be stuck before the watchdog recovers it (5 minutes)
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
// Maximum number of recovery attempts per document before marking as FAILED
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Recover stale citation/style jobs.
 *
 * When BullMQ jobs fail all retries, the DB record stays stuck in QUEUED or
 * ANALYZING forever. This function finds such stale documents and either
 * re-queues them (up to MAX_RECOVERY_ATTEMPTS times) or marks them as FAILED.
 *
 * Called both on startup and periodically by the watchdog interval.
 */
async function recoverStaleJobs(): Promise<void> {
  if (!areQueuesAvailable()) return;
  if (isRecovering) {
    logger.debug('[Recovery] Skipping — previous recovery still in progress');
    return;
  }

  isRecovering = true;
  try {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    const staleDocuments = await prisma.editorialDocument.findMany({
      where: {
        status: { in: ['QUEUED', 'ANALYZING'] },
        updatedAt: { lt: staleThreshold },
      },
      select: {
        id: true,
        status: true,
        tenantId: true,
        jobId: true,
        updatedAt: true,
        job: {
          select: {
            id: true,
            status: true,
            userId: true,
            input: true,
          },
        },
      },
    });

    if (staleDocuments.length === 0) return;

    logger.info(`[Recovery] Found ${staleDocuments.length} stale document(s) to recover`);

    const citationQueue = getCitationQueue();
    if (!citationQueue) {
      logger.warn('[Recovery] Citation queue not available, skipping recovery');
      return;
    }

    for (const doc of staleDocuments) {
      try {
        const oldJobId = doc.jobId || doc.job?.id;
        const userId = doc.job?.userId || 'system';
        const tenantId = doc.tenantId;

        // Count how many times this document has been recovered by checking the chain
        const jobInput = doc.job?.input as Record<string, unknown> | null;
        const recoveryCount = (jobInput?.recoveryCount as number) || 0;

        if (recoveryCount >= MAX_RECOVERY_ATTEMPTS) {
          logger.warn(`[Recovery] Document ${doc.id} exceeded max recovery attempts (${recoveryCount}), marking as FAILED`);
          await prisma.editorialDocument.update({
            where: { id: doc.id },
            data: { status: 'FAILED' },
          });
          if (doc.jobId) {
            await prisma.job.update({
              where: { id: doc.jobId },
              data: { status: 'FAILED', error: `Job failed after ${recoveryCount} recovery attempts` },
            }).catch(() => { /* ignore if job record doesn't exist */ });
          }
          continue;
        }

        logger.info(`[Recovery] Re-queuing document ${doc.id} (was ${doc.status} since ${doc.updatedAt.toISOString()}, attempt ${recoveryCount + 1}/${MAX_RECOVERY_ATTEMPTS})`);

        // Remove stale BullMQ job if it exists (may be in failed/completed state)
        if (oldJobId) {
          try {
            const existingJob = await citationQueue.getJob(oldJobId);
            if (existingJob) {
              const state = await existingJob.getState().catch(() => 'unknown');
              await existingJob.remove();
              logger.info(`[Recovery] Removed stale BullMQ job ${oldJobId} (was ${state})`);
            }
          } catch { /* ignore — job may not exist in Redis */ }
        }

        // Always create a fresh job record to avoid BullMQ duplicate-ID conflicts
        const newJob = await prisma.job.create({
          data: {
            tenantId,
            userId,
            type: 'CITATION_DETECTION',
            status: 'QUEUED',
            input: {
              recoveredFrom: oldJobId,
              recoveredAt: new Date().toISOString(),
              recoveryCount: recoveryCount + 1,
            },
          },
        });

        // Point document to the new job and reset status
        await prisma.editorialDocument.update({
          where: { id: doc.id },
          data: { status: 'QUEUED', jobId: newJob.id },
        });

        // Add to BullMQ queue with the new job ID
        await citationQueue.add(
          `citation-${doc.id}`,
          {
            type: JOB_TYPES.CITATION_DETECTION,
            tenantId,
            userId,
            options: { documentId: doc.id },
          },
          { jobId: newJob.id, priority: 1 }
        );

        logger.info(`[Recovery] Successfully re-queued document ${doc.id} with new job ${newJob.id}`);
      } catch (err) {
        logger.error(`[Recovery] Failed to recover document ${doc.id}:`, err);
      }
    }
  } catch (err) {
    logger.error('[Recovery] Stale job recovery failed:', err);
  } finally {
    isRecovering = false;
  }
}

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

  const citationWorker = createWorker({
    queueName: QUEUE_NAMES.CITATION_PROCESSING,
    processor: processCitationJob,
    concurrency: 2,
  });
  if (citationWorker) workers.push(citationWorker);

  const styleWorker = createWorker({
    queueName: QUEUE_NAMES.STYLE_PROCESSING,
    processor: processStyleJob,
    concurrency: 2,
  });
  if (styleWorker) workers.push(styleWorker);

  if (isRedisConfigured()) {
    const connection = getBullMQConnection();
    if (connection) {
      const batchWorker = new Worker<BatchJobData, BatchJobResult>(
        QUEUE_NAMES.BATCH_REMEDIATION,
        processBatchJob,
        { connection, concurrency: 1, autorun: true, prefix: QUEUE_PREFIX }
      );
      batchWorker.on('completed', (job) => {
        logger.info(`📗 Batch job ${job.id} completed`);
      });
      batchWorker.on('failed', (job, err) => {
        logger.error(`📕 Batch job ${job?.id} failed: ${err.message}`);
      });
      workers.push(batchWorker);

      const batchProcessingWorker = new Worker<BatchProcessingJobData, BatchProcessingJobResult>(
        QUEUE_NAMES.BATCH_PROCESSING,
        processBatchProcessingJob,
        {
          connection,
          concurrency: 1,
          prefix: QUEUE_PREFIX,
          limiter: {
            max: 5,
            duration: 60000,
          },
        }
      );
      batchProcessingWorker.on('completed', (job) => {
        logger.info(`📗 Batch processing job ${job.id} completed`);
      });
      batchProcessingWorker.on('failed', (job, err) => {
        logger.error(`📕 Batch processing job ${job?.id} failed: ${err.message}`);
      });
      batchProcessingWorker.on('error', (err) => {
        logger.error('[BatchProcessingWorker] Worker error:', err);
      });
      workers.push(batchProcessingWorker);

      // Workflow automation worker
      const workflowWorker = startWorkflowWorker();
      workflowWorker.on('completed', (job) => {
        logger.info(`🔄 Workflow event ${job.id} completed`);
      });
      workflowWorker.on('failed', (job, err) => {
        logger.error(`🔄 Workflow event ${job?.id} failed: ${err.message}`);
      });
      workflowWorker.on('error', (err) => {
        logger.error('[WorkflowWorker] Worker error:', err);
      });
      workers.push(workflowWorker);
      logger.info('✅ Workflow automation worker started');
    }
  }

  if (workers.length > 0) {
    logger.info(`✅ ${workers.length} workers started`);

    // Recover stale jobs after workers are ready to process them
    recoverStaleJobs().catch(err => {
      logger.error('[Recovery] Startup recovery failed:', err);
    });

    // Start periodic watchdog to catch jobs that get stuck during runtime
    // (e.g., BullMQ job fails all retries but DB stays in QUEUED/ANALYZING)
    watchdogInterval = setInterval(() => {
      recoverStaleJobs().catch(err => {
        logger.error('[Watchdog] Periodic recovery failed:', err);
      });
    }, WATCHDOG_INTERVAL_MS);
    logger.info(`✅ Stale job watchdog started (every ${WATCHDOG_INTERVAL_MS / 1000}s)`);
  } else {
    logger.warn('⚠️  No workers started (Redis may not be configured)');
  }
}

export async function stopWorkers(): Promise<void> {
  logger.info('🛑 Stopping workers...');
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  logger.info('✅ All workers stopped');
}

export function getActiveWorkers(): number {
  return workers.length;
}
