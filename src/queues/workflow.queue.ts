import { Queue, Worker, Job } from 'bullmq';
import { getBullMQConnection } from './index';
import { logger } from '../lib/logger';
import { websocketService } from '../services/workflow/websocket.service';
import prisma from '../lib/prisma';
import { config } from '../config';

interface WorkflowJobData {
  workflowId: string;
  event: string;
  payload?: unknown;
}

const QUEUE_NAME = 'workflow-processing';

let _workflowQueue: Queue<WorkflowJobData> | null = null;

function getConnection() {
  const connection = getBullMQConnection();
  if (!connection) {
    throw new Error('Redis not configured — workflow queue unavailable');
  }
  return connection;
}

export function getWorkflowQueue(): Queue<WorkflowJobData> {
  if (!_workflowQueue) {
    _workflowQueue = new Queue<WorkflowJobData>(QUEUE_NAME, {
      connection: getConnection(),
    });
  }
  return _workflowQueue;
}

// Named export alias expected by consumers
export const workflowQueue = {
  get instance() {
    return getWorkflowQueue();
  },
};

export function startWorkflowWorker(): Worker {
  const worker = new Worker<WorkflowJobData>(
    QUEUE_NAME,
    async (job: Job<WorkflowJobData>) => {
      const { workflowId, event, payload } = job.data;

      logger.info(`[Queue Worker] Processing ${event} for workflow ${workflowId}`);

      const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');

      if (event === 'REPROCESS_STATE') {
        // Re-run the handler for the current state without a state transition.
        // Used to unstick workflows that were in-flight when the worker crashed.
        logger.info(`[Queue Worker] Reprocessing current state for workflow ${workflowId}`);
        await workflowAgentService.processWorkflowState(workflowId);
      } else {
        const { workflowService } = await import('../services/workflow/workflow.service');
        try {
          await workflowService.transition(workflowId, event, payload as never);
          logger.info(`[Queue Worker] State transition completed for workflow ${workflowId}`);
        } catch (transitionErr) {
          const msg = transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
          if (msg.startsWith('Invalid transition:')) {
            // The workflow is already past this state — a previous attempt of this job ran
            // the transition successfully before the worker was killed/stalled.
            // Re-run processWorkflowState so the workflow can continue from its current state.
            logger.warn(`[Queue Worker] Transition already applied (${msg}), re-running processWorkflowState to advance`);
          } else {
            throw transitionErr;
          }
        }
        await workflowAgentService.processWorkflowState(workflowId);
      }

      logger.info(`[Queue Worker] Completed ${event} for workflow ${workflowId}`);

      // Emit batch progress if this workflow is part of a batch
      if (config.features.enableWebSocket && config.features.emitBatchProgress) {
        const workflow = await prisma.workflowInstance.findUnique({
          where: { id: workflowId },
          select: { batchId: true },
        });

        if (workflow?.batchId) {
          const batchStats = await prisma.workflowInstance.groupBy({
            by: ['currentState'],
            where: { batchId: workflow.batchId },
            _count: true,
          });

          const total = batchStats.reduce((sum, s) => sum + s._count, 0);
          const completed = batchStats.find(s => s.currentState === 'COMPLETED')?._count || 0;
          const failed = batchStats.find(s => s.currentState === 'FAILED')?._count || 0;

          const currentStages: Record<string, number> = {};
          batchStats.forEach(s => {
            if (s.currentState !== 'COMPLETED' && s.currentState !== 'FAILED') {
              currentStages[s.currentState] = s._count;
            }
          });

          websocketService.emitBatchProgress({
            batchId: workflow.batchId,
            completed,
            total,
            currentStages,
            failedCount: failed,
          });
        }
      }
    },
    {
      connection: getConnection(),
      concurrency: 3,
      // Kill jobs that run longer than 10 minutes — audit services can hang on large files
      lockDuration: 600_000,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[Queue Worker] Job ${job?.id} failed:`, err);
  });

  return worker;
}

export async function enqueueWorkflowEvent(
  workflowId: string,
  event: string,
  payload?: unknown
): Promise<void> {
  await getWorkflowQueue().add(
    event,
    { workflowId, event, payload },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    }
  );
}
