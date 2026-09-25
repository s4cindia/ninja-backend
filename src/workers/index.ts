import { Worker } from 'bullmq';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, QUEUE_PREFIX, BatchJobData, BatchJobResult, BatchProcessingJobData, BatchProcessingJobResult, getBullMQConnection, getCitationQueue, getAccessibilityQueue, JOB_TYPES, areQueuesAvailable } from '../queues';
import { processAccessibilityJob } from './processors/accessibility.processor';
import { processVpatJob } from './processors/vpat.processor';
import { processFileJob } from './processors/file.processor';
import { processBatchJob } from './processors/batch.processor';
import { processBatchProcessingJob } from './processors/batch-processing.processor';
import { processCitationJob } from './processors/citation.processor';
import { startWorkflowWorker as createWorkflowQueueWorker } from '../queues/workflow.queue';
import { processStyleJob } from './processors/style.processor';
import { startCalibrationWorker } from './calibration.worker';
import { isRedisConfigured } from '../lib/redis';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';

// Split into two independently start/stoppable groups for the web/worker
// process split (PROCESS_ROLE): backgroundWorkers is every CPU/IO-heavy
// BullMQ consumer (accessibility, vpat, file, citation, style, calibration,
// batch-remediation, batch-processing) -- these belong on the worker
// process. workflowWorkers is just the workflow-processing queue, which
// stays on the web process because its processor calls websocketService
// directly (see queues/workflow.queue.ts) and there is no cross-process
// relay for that today.
let backgroundWorkers: Worker[] = [];
let workflowWorkers: Worker[] = [];
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
 *
 * NOTE: Currently only re-queues to the citation queue. Documents stuck due to
 * style processing failures will be marked FAILED after MAX_RECOVERY_ATTEMPTS
 * but not re-routed to the style queue. Extend when style queue recovery is needed.
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

        // Update document first so recoveryCount is always read from the new job.
        // If enqueue fails, revert the document so it stays in stale state for next cycle.
        await prisma.editorialDocument.update({
          where: { id: doc.id },
          data: { status: 'QUEUED', jobId: newJob.id },
        });

        try {
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
        } catch (queueErr) {
          // Revert document so next watchdog cycle can retry
          await prisma.editorialDocument.update({
            where: { id: doc.id },
            data: { status: doc.status, ...(oldJobId ? { jobId: oldJobId } : {}) },
          }).catch(() => { /* best-effort revert */ });
          throw queueErr;
        }

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

/**
 * On server startup, clean up any BullMQ jobs that were left in "active" state
 * by a previous (now dead) worker process, and fix the corresponding DB records.
 * This prevents new jobs from waiting behind orphaned active slots.
 */
async function cleanupStaleActiveJobs(): Promise<void> {
  if (!areQueuesAvailable()) return;
  try {
    const queue = getAccessibilityQueue();
    if (!queue) return;

    // Log queue counts for diagnostics
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'paused', 'failed');
    logger.info(`[Startup] Accessibility queue counts: waiting=${counts.waiting} active=${counts.active} delayed=${counts.delayed} paused=${counts.paused} failed=${counts.failed}`);

    // Ensure queue is not paused (paused state persists in Redis across restarts)
    const isPaused = await queue.isPaused();
    if (isPaused) {
      logger.warn('[Startup] Accessibility queue is PAUSED — resuming it now');
      await queue.resume();
      logger.info('[Startup] Accessibility queue resumed');
    }

    // Collect active jobs before cleaning so we can update DB records
    const activeJobs = await queue.getActive();
    if (activeJobs.length === 0) return;

    logger.info(`[Startup] Found ${activeJobs.length} stale active job(s) from previous process — cleaning up`);

    // Update DB records first (before removing from Redis)
    for (const bullJob of activeJobs) {
      const dbJobId = (bullJob.data?.options?.dbJobId as string | undefined) || bullJob.id;
      if (dbJobId) {
        await prisma.job.updateMany({
          where: { id: dbJobId, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            error: 'Server restarted while job was processing — please re-submit the file',
          },
        }).catch(err => logger.warn(`[Startup] Failed to update DB for stale job ${dbJobId}: ${err.message}`));
      }
    }

    // Remove stale active jobs from Redis using queue.clean() — no lock token required
    const removed = await queue.clean(0, activeJobs.length + 10, 'active');
    logger.info(`[Startup] Stale active job cleanup complete — removed ${removed.length} BullMQ job(s)`);
  } catch (err) {
    logger.warn(`[Startup] Stale active job cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Every CPU/IO-heavy BullMQ consumer except workflow-processing: accessibility,
 * vpat, file, citation, style, calibration, batch-remediation, batch-processing.
 * Belongs on the worker process (PROCESS_ROLE=worker) -- this is the group
 * that was originally implicated in the CPU-starves-health-checks incident
 * (accessibility-validation specifically), and none of the others emit
 * WebSocket events, so all of them are safe to move together.
 */
export function startBackgroundWorkers(): void {
  logger.info('🚀 Starting background job workers...');

  const accessibilityWorker = createWorker({
    queueName: QUEUE_NAMES.ACCESSIBILITY,
    processor: processAccessibilityJob,
    concurrency: 5,
    lockDuration: 10 * 60 * 1000, // 10 min — PDF audits can be slow for large files
    stalledInterval: 5000, // 5 s — quickly reclaim orphaned active jobs from old server instances
  });
  if (accessibilityWorker) backgroundWorkers.push(accessibilityWorker);

  const vpatWorker = createWorker({
    queueName: QUEUE_NAMES.VPAT,
    processor: processVpatJob,
    concurrency: 1,
  });
  if (vpatWorker) backgroundWorkers.push(vpatWorker);

  const fileWorker = createWorker({
    queueName: QUEUE_NAMES.FILE_PROCESSING,
    processor: processFileJob,
    concurrency: 2,
  });
  if (fileWorker) backgroundWorkers.push(fileWorker);

  const citationWorker = createWorker({
    queueName: QUEUE_NAMES.CITATION_PROCESSING,
    processor: processCitationJob,
    concurrency: 2,
  });
  if (citationWorker) backgroundWorkers.push(citationWorker);

  const styleWorker = createWorker({
    queueName: QUEUE_NAMES.STYLE_PROCESSING,
    processor: processStyleJob,
    concurrency: 2,
  });
  if (styleWorker) backgroundWorkers.push(styleWorker);

  const calibrationWorker = startCalibrationWorker();
  if (calibrationWorker) backgroundWorkers.push(calibrationWorker);

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
      backgroundWorkers.push(batchWorker);

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
      backgroundWorkers.push(batchProcessingWorker);
    }
  }

  if (backgroundWorkers.length > 0) {
    logger.info(`✅ ${backgroundWorkers.length} background workers started`);

    // Clean up any stale active BullMQ jobs left by a previous server process.
    // Must run BEFORE recoverStaleJobs so freed slots are visible to the stale-job recovery.
    cleanupStaleActiveJobs().catch(err => {
      logger.error('[Startup] Stale active job cleanup failed:', err);
    });

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
    logger.warn('⚠️  No background workers started (Redis may not be configured)');
  }
}

export async function stopBackgroundWorkers(): Promise<void> {
  logger.info('🛑 Stopping background workers...');
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  await Promise.all(backgroundWorkers.map((worker) => worker.close()));
  backgroundWorkers = [];
  logger.info('✅ All background workers stopped');
}

/**
 * Just the workflow-processing queue's worker. Kept separate from
 * startBackgroundWorkers() because its processor calls websocketService
 * directly (see queues/workflow.queue.ts) -- websocketService.io is only
 * ever set on the process that called websocketService.initialize(server),
 * i.e. the web process. Moving this worker to a separate process would make
 * every workflow WebSocket event silently no-op with no error. It isn't
 * CPU-heavy, so there's no upside to moving it anyway.
 */
export function startWorkflowQueueWorker(): void {
  if (!isRedisConfigured()) return;
  const connection = getBullMQConnection();
  if (!connection) return;

  const workflowWorker = createWorkflowQueueWorker();
  workflowWorker.on('completed', (job) => {
    logger.info(`🔄 Workflow event ${job.id} completed`);
  });
  workflowWorker.on('failed', (job, err) => {
    logger.error(`🔄 Workflow event ${job?.id} failed: ${err.message}`);
  });
  workflowWorker.on('error', (err) => {
    logger.error('[WorkflowWorker] Worker error:', err);
  });
  workflowWorkers.push(workflowWorker);
  logger.info('✅ Workflow automation worker started');
}

export async function stopWorkflowQueueWorker(): Promise<void> {
  await Promise.all(workflowWorkers.map((worker) => worker.close()));
  workflowWorkers = [];
}

/** Legacy/default (PROCESS_ROLE unset): everything in one process, unchanged from before the web/worker split. */
export function startWorkers(): void {
  startBackgroundWorkers();
  startWorkflowQueueWorker();
}

export async function stopWorkers(): Promise<void> {
  await Promise.all([stopBackgroundWorkers(), stopWorkflowQueueWorker()]);
}

export function getActiveWorkers(): number {
  return backgroundWorkers.length + workflowWorkers.length;
}
