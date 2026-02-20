import { Queue, Worker, Job } from 'bullmq';
import { getBullMQConnection } from './index';
import { logger } from '../lib/logger';

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

      // @ts-expect-error — workflow.service is owned by T1 and not yet merged
      const { workflowService } = await import('../services/workflow/workflow.service');
      await workflowService.transition(workflowId, event, payload as never);

      logger.info(`[Queue Worker] Completed ${event} for workflow ${workflowId}`);
    },
    {
      connection: getConnection(),
      concurrency: 3,
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
