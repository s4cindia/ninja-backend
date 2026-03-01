import prisma from '../../lib/prisma';
import { enqueueWorkflowEvent } from '../../queues/workflow.queue';
import { logger } from '../../lib/logger';

/**
 * States that represent active processing — workflows stuck here need recovery.
 * Excludes HITL gates (require human action) and terminal states.
 */
const RECOVERABLE_STATES = [
  'UPLOAD_RECEIVED',
  'PREPROCESSING',
  'RUNNING_EPUBCHECK',
  'RUNNING_ACE',
  'RUNNING_AI_ANALYSIS',
  'AUTO_REMEDIATION',
  'VERIFICATION_AUDIT',
  'CONFORMANCE_MAPPING',
  'ACR_GENERATION',
  'RETRYING',
];

/**
 * Minimum age before a workflow in an active state is considered stuck.
 * Prevents re-queuing workflows that were just created and are being processed normally.
 */
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

async function recoverStuckWorkflows(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

  const stuck = await prisma.workflowInstance.findMany({
    where: {
      currentState: { in: RECOVERABLE_STATES },
      startedAt: { lt: staleThreshold },
    },
    select: { id: true, currentState: true },
  });

  if (stuck.length === 0) {
    logger.debug('[Recovery] No stuck workflows found');
    return;
  }

  logger.warn(`[Recovery] Found ${stuck.length} stuck workflow(s) — re-enqueuing`, {
    workflows: stuck.map(w => ({ id: w.id, state: w.currentState })),
  });

  for (const wf of stuck) {
    try {
      await enqueueWorkflowEvent(wf.id, 'REPROCESS_STATE');
      logger.info(`[Recovery] Re-enqueued ${wf.id} (stuck in ${wf.currentState})`);
    } catch (err) {
      logger.error(`[Recovery] Failed to re-enqueue ${wf.id}:`, err);
    }
  }
}

let _recoveryInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Run an immediate recovery scan, then schedule one every 5 minutes.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startWorkflowRecovery(): void {
  if (_recoveryInterval) return;

  // Immediate scan on startup
  recoverStuckWorkflows().catch(err => {
    logger.error('[Recovery] Startup scan failed:', err);
  });

  // Periodic scan every 5 minutes
  _recoveryInterval = setInterval(() => {
    recoverStuckWorkflows().catch(err => {
      logger.error('[Recovery] Periodic scan failed:', err);
    });
  }, 5 * 60 * 1000);
}

export function stopWorkflowRecovery(): void {
  if (_recoveryInterval) {
    clearInterval(_recoveryInterval);
    _recoveryInterval = null;
  }
}
