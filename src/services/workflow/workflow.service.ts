import { createActor } from 'xstate';
import { WorkflowMachine } from './workflow-states';
import { WorkflowInstance, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';

import { WorkflowState } from '../../types/workflow-contracts';

// WFState alias kept for symmetry with spec import
type WFState = WorkflowState;

class WorkflowService {
  async createWorkflow(
    fileId: string,
    createdBy: string,
    batchId?: string,
  ): Promise<WorkflowInstance> {
    const id = crypto.randomUUID();
    return prisma.workflowInstance.create({
      data: {
        id,
        fileId,
        createdBy,
        batchId,
        currentState: 'UPLOAD_RECEIVED',
        stateData: {},
      },
    });
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

    return updated;
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
