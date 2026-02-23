import { createActor } from 'xstate';
import { WorkflowMachine } from './workflow-states';
import { WorkflowInstance, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { workflowConfigService } from './workflow-config.service';
import { HitlGateConfig } from '../../types/workflow-config.types';
import { enqueueWorkflowEvent } from '../../queues/workflow.queue';
import { logger } from '../../lib/logger';
import { websocketService } from './websocket.service';
import { config } from '../../config';

class WorkflowService {
  async createWorkflow(
    fileId: string,
    createdBy: string,
    batchId?: string,
  ): Promise<WorkflowInstance> {
    const id = crypto.randomUUID();
    const workflow = await prisma.workflowInstance.create({
      data: {
        id,
        fileId,
        createdBy,
        batchId,
        currentState: 'UPLOAD_RECEIVED',
        stateData: {},
      },
    });

    // Auto-trigger workflow processing via queue, with fallback to direct processing
    logger.info(`[Workflow] Auto-triggering workflow ${id}`);
    try {
      await enqueueWorkflowEvent(id, 'PREPROCESS');
    } catch (queueErr) {
      logger.warn(`[Workflow] Queue unavailable, falling back to direct processing: ${queueErr}`);
      // Fire-and-forget direct processing so workflow record is still returned immediately
      import('./workflow-agent.service').then(({ workflowAgentService }) => {
        workflowAgentService.processWorkflowState(id).catch(err => {
          logger.error(`[Workflow] Direct processing failed for ${id}:`, err);
        });
      }).catch(err => {
        logger.error(`[Workflow] Failed to import workflow agent service for ${id}:`, err);
      });
    }

    return workflow;
  }

  async getWorkflow(workflowId: string): Promise<WorkflowInstance | null> {
    return prisma.workflowInstance.findUnique({ where: { id: workflowId } });
  }

  async transition(
    workflowId: string,
    event: string,
    payload?: Record<string, unknown>,
  ): Promise<WorkflowInstance> {
    const instance = await prisma.workflowInstance.findUnique({ where: { id: workflowId } });
    if (!instance) {
      const err = new Error(`Workflow ${workflowId} not found`);
      (err as NodeJS.ErrnoException & { statusCode: number }).statusCode = 404;
      throw err;
    }

    const fromState = instance.currentState;

    // Reconstruct machine actor from persisted state
    const resolvedSnapshot = WorkflowMachine.resolveState({
      value: fromState,
      context: {
        workflowId: instance.id,
        fileId: instance.fileId,
        currentState: instance.currentState,
        stateData: (instance.stateData as Record<string, unknown>) ?? {},
        retryCount: instance.retryCount,
        loopCount: instance.loopCount,
        errorMessage: instance.errorMessage ?? undefined,
        batchId: instance.batchId ?? undefined,
      },
    });

    const actor = createActor(WorkflowMachine, { snapshot: resolvedSnapshot });
    actor.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actor.send({ type: event } as any);
    const newState = actor.getSnapshot().value as string;
    actor.stop();

    if (newState === fromState) {
      throw new Error(`Invalid transition: ${event} from ${fromState}`);
    }

    // Enhanced logging for state transitions
    logger.info(`[Workflow] Transition: ${fromState} --[${event}]--> ${newState}`, {
      workflowId,
      fromState,
      event,
      toState: newState,
      payload: payload ? Object.keys(payload) : [],
      timestamp: new Date().toISOString(),
    });

    const mergedStateData = {
      ...(instance.stateData as Record<string, unknown>),
      ...payload,
    };

    const [updated] = await prisma.$transaction([
      prisma.workflowInstance.update({
        where: { id: workflowId },
        data: {
          currentState: newState,
          stateData: mergedStateData as unknown as Prisma.InputJsonValue,
          ...(newState === 'COMPLETED' ? { completedAt: new Date() } : {}),
        },
      }),
      prisma.workflowEvent.create({
        data: {
          workflowId,
          eventType: event,
          fromState,
          toState: newState,
          payload: (payload ?? {}) as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    logger.info(`[Workflow] State persisted: ${workflowId} is now in ${newState}`, {
      workflowId,
      currentState: updated.currentState,
      completedAt: updated.completedAt,
      stateDataKeys: Object.keys(mergedStateData),
    });

    // Emit WebSocket state change event (best-effort — never break state transition)
    if (config.features.enableWebSocket && config.features.emitAllTransitions) {
      try {
        websocketService.emitStateChange({
          workflowId,
          from: fromState as import('../../types/workflow-contracts').WorkflowState,
          to: newState as import('../../types/workflow-contracts').WorkflowState,
          timestamp: new Date().toISOString(),
          phase: this.computePhase(newState),
        });
      } catch (err) {
        logger.warn(`[Workflow] WebSocket emit failed for ${workflowId}`, err);
      }
    }

    return updated;
  }

  /**
   * Schedule a configurable HITL timeout for a workflow.
   * Fetches the tenant configuration and returns the timeout value.
   * Returns null if no timeout is configured (manual approval required).
   *
   * @param workflowId - Workflow instance ID
   * @param gateName - HITL gate configuration key
   * @returns Timeout in milliseconds, or null for no timeout
   */
  async getHitlTimeout(
    workflowId: string,
    gateName: keyof HitlGateConfig,
  ): Promise<number | null> {
    // Fetch workflow to get fileId
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    // Fetch file to get tenantId
    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
      select: { tenantId: true },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found for workflow ${workflowId}`);
    }

    // Get configured timeout from tenant settings
    const timeoutMs = await workflowConfigService.getGateTimeout(
      file.tenantId,
      gateName
    );

    logger.debug(`[Workflow] HITL timeout for ${gateName} on workflow ${workflowId}:`, {
      timeoutMs: timeoutMs === null ? 'none' : `${timeoutMs}ms`,
      tenantId: file.tenantId,
    });

    return timeoutMs;
  }

  computePhase(
    state: string,
  ): 'ingest' | 'audit' | 'remediate' | 'certify' | 'complete' | 'failed' {
    if (['UPLOAD_RECEIVED', 'PREPROCESSING'].includes(state)) return 'ingest';
    if (['RUNNING_EPUBCHECK', 'RUNNING_ACE', 'RUNNING_AI_ANALYSIS', 'AWAITING_AI_REVIEW'].includes(state)) return 'audit';
    if (['AUTO_REMEDIATION', 'AWAITING_REMEDIATION_REVIEW', 'VERIFICATION_AUDIT'].includes(state)) return 'remediate';
    if (['CONFORMANCE_MAPPING', 'AWAITING_CONFORMANCE_REVIEW', 'ACR_GENERATION', 'AWAITING_ACR_SIGNOFF'].includes(state)) return 'certify';
    if (state === 'COMPLETED') return 'complete';
    return 'failed';
  }

  computeProgress(state: string): number {
    const progressMap: Record<string, number> = {
      UPLOAD_RECEIVED: 5,
      PREPROCESSING: 10,
      RUNNING_EPUBCHECK: 20,
      RUNNING_ACE: 30,
      RUNNING_AI_ANALYSIS: 40,
      AWAITING_AI_REVIEW: 45,
      AUTO_REMEDIATION: 55,
      AWAITING_REMEDIATION_REVIEW: 60,
      VERIFICATION_AUDIT: 65,
      CONFORMANCE_MAPPING: 70,
      AWAITING_CONFORMANCE_REVIEW: 75,
      ACR_GENERATION: 85,
      AWAITING_ACR_SIGNOFF: 90,
      COMPLETED: 100,
      FAILED: 0,
    };
    return progressMap[state] ?? 50;
  }
}

export const workflowService = new WorkflowService();
