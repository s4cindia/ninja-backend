import { Queue, Worker, Job } from 'bullmq';
import { getBullMQConnection, QUEUE_PREFIX } from './index';
import { logger } from '../lib/logger';
import { websocketService } from '../services/workflow/websocket.service';
import prisma from '../lib/prisma';
import { config } from '../config';
import { emailService } from '../services/email/email.service';
import { notificationService } from '../services/notification/notification.service';

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
      prefix: QUEUE_PREFIX,
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

      // Check if this workflow is part of a batch
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id: workflowId },
        select: { batchId: true },
      });

      if (workflow?.batchId) {
        const batchId = workflow.batchId;

        // Fetch batch record and stats in parallel
        const [batchRecord, batchStats] = await Promise.all([
          prisma.batchWorkflow.findUnique({
            where: { id: batchId },
            include: {
              user: { select: { email: true, firstName: true, lastName: true, tenantId: true } },
            },
          }),
          prisma.workflowInstance.groupBy({
            by: ['currentState'],
            where: { batchId },
            _count: true,
          }),
        ]);

        const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
        const total = batchStats.reduce((sum, s) => sum + s._count, 0);
        const completed = batchStats.find(s => s.currentState === 'COMPLETED')?._count ?? 0;
        const failed = batchStats.find(s => s.currentState === 'FAILED')?._count ?? 0;
        const terminalCount = batchStats
          .filter(s => TERMINAL_STATES.has(s.currentState))
          .reduce((sum, s) => sum + s._count, 0);

        // 1. Emit batch progress via WebSocket if enabled
        if (config.features.enableWebSocket && config.features.emitBatchProgress) {
          const currentStages: Record<string, number> = {};
          batchStats.forEach(s => {
            if (!TERMINAL_STATES.has(s.currentState)) {
              currentStages[s.currentState] = s._count;
            }
          });
          websocketService.emitBatchProgress({ batchId, completed, total, currentStages, failedCount: failed });
        }

        // 2. HITL gate notifications — fire once per batch per gate (idempotent via unique link)
        if (batchRecord?.user) {
          const { email, firstName, lastName, tenantId } = batchRecord.user;
          const userName = `${firstName ?? ''} ${lastName ?? ''}`.trim() || email;
          const batchUrl = `${process.env.APP_URL ?? ''}/workflow/batch/${batchId}`;

          const HITL_GATES = [
            { state: 'AWAITING_AI_REVIEW',          gateName: 'AI Review',          gateKey: 'ai_review' },
            { state: 'AWAITING_REMEDIATION_REVIEW', gateName: 'Remediation Review', gateKey: 'remediation_review' },
            { state: 'AWAITING_CONFORMANCE_REVIEW', gateName: 'Conformance Review', gateKey: 'conformance_review' },
            { state: 'AWAITING_ACR_SIGNOFF',        gateName: 'ACR Sign-off',       gateKey: 'acr_signoff' },
          ] as const;

          for (const { state, gateName, gateKey } of HITL_GATES) {
            const waitingCount = batchStats.find(s => s.currentState === state)?._count ?? 0;
            if (waitingCount === 0) continue;

            // Unique link per batch+gate acts as idempotency key
            const gateLink = `/workflow/batch/${batchId}?gate=${gateKey}`;
            const alreadyNotified = await prisma.notification.findFirst({
              where: { userId: batchRecord.createdBy, link: gateLink },
              select: { id: true },
            });
            if (alreadyNotified) continue;

            emailService.sendBatchHITLEmail({
              userName,
              userEmail: email,
              batchName: batchRecord.name,
              batchId,
              gateName,
              waitingCount,
              reviewUrl: batchUrl,
            }).catch((err: Error) =>
              logger.error(`[Queue Worker] Failed to send HITL email for batch ${batchId} gate ${gateKey}: ${err.message}`)
            );

            notificationService.createNotification({
              userId: batchRecord.createdBy,
              tenantId,
              type: 'SYSTEM_ALERT',
              title: `Action Required: ${gateName}`,
              message: `Your batch "${batchRecord.name}" has ${waitingCount} file(s) waiting for ${gateName}. Please review to continue processing.`,
              data: { batchId, batchName: batchRecord.name, gate: gateKey, waitingCount },
              link: gateLink,
            }).catch((err: Error) =>
              logger.error(`[Queue Worker] Failed to create HITL notification for batch ${batchId} gate ${gateKey}: ${err.message}`)
            );
          }
        }

        // 3. Batch completion — idempotent via updateMany status guard (concurrency 3)
        if (total > 0 && terminalCount === total) {
          const isFailed = completed === 0;
          const { count } = await prisma.batchWorkflow.updateMany({
            where: { id: batchId, status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] } },
            data: { status: isFailed ? 'FAILED' : 'COMPLETED', completedAt: new Date() },
          });

          if (count > 0 && batchRecord?.user) {
            const { email, firstName, lastName, tenantId } = batchRecord.user;
            const userName = `${firstName ?? ''} ${lastName ?? ''}`.trim() || email;
            const resultsUrl = `${process.env.APP_URL ?? ''}/workflow/batch/${batchId}`;

            if (isFailed) {
              const errorMsg = `${failed} of ${total} workflow(s) failed or were cancelled.`;

              emailService.sendBatchFailureEmail({
                userName, userEmail: email, batchName: batchRecord.name,
                batchId, errorMessage: errorMsg, resultsUrl,
              }).catch((err: Error) =>
                logger.error(`[Queue Worker] Failed to send failure email for batch ${batchId}: ${err.message}`)
              );

              notificationService.createNotification({
                userId: batchRecord.createdBy, tenantId, type: 'BATCH_FAILED',
                title: 'Batch Processing Failed',
                message: `Your batch "${batchRecord.name}" encountered errors: ${errorMsg}`,
                data: { batchId, batchName: batchRecord.name, error: errorMsg },
                link: `/workflow/batch/${batchId}`,
              }).catch((err: Error) =>
                logger.error(`[Queue Worker] Failed to create failure notification for batch ${batchId}: ${err.message}`)
              );
            } else {
              emailService.sendBatchCompletionEmail({
                userName, userEmail: email, batchName: batchRecord.name, batchId,
                totalFiles: total, filesSuccessful: completed, filesFailed: failed,
                totalIssues: 0, autoFixed: 0, quickFixes: 0, manualFixes: 0,
                processingTime: 'N/A', resultsUrl,
              }).catch((err: Error) =>
                logger.error(`[Queue Worker] Failed to send completion email for batch ${batchId}: ${err.message}`)
              );

              notificationService.createNotification({
                userId: batchRecord.createdBy, tenantId, type: 'BATCH_COMPLETED',
                title: 'Batch Processing Complete',
                message: `Your batch "${batchRecord.name}" completed. ${completed} of ${total} workflow(s) succeeded.`,
                data: { batchId, batchName: batchRecord.name, completed, total, failed },
                link: `/workflow/batch/${batchId}`,
              }).catch((err: Error) =>
                logger.error(`[Queue Worker] Failed to create completion notification for batch ${batchId}: ${err.message}`)
              );
            }
          }
        }
      }
    },
    {
      connection: getConnection(),
      concurrency: 3,
      // Kill jobs that run longer than 10 minutes — audit services can hang on large files
      lockDuration: 600_000,
      prefix: QUEUE_PREFIX,
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
