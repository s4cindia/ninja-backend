import { Request, Response, NextFunction } from 'express';
import {
  startWorkflowSchema,
  aiReviewDecisionSchema,
  remediationFixSchema,
  remediationReviewSchema,
  conformanceReviewSchema,
  acrSignoffSchema,
  workflowParamsSchema,
  startBatchSchema,
  HITLGate,
  HITLAction,
  WorkflowState,
} from '../types/workflow-contracts';
import type { WorkflowStatusResponse, BatchAutoApprovalPolicy } from '../types/workflow-contracts';
import { workflowConfigService } from '../services/workflow/workflow-config.service';
import prisma, { Prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

// TODO: workflowService lives on feature/wf-state-machine — resolves after T1 merges
// @ts-ignore
import { workflowService } from '../services/workflow/workflow.service';

// TODO: hitlOrchestratorService lives on feature/wf-hitl-gateway — resolves after T2 merges
// @ts-ignore
import { hitlOrchestratorService } from '../services/workflow/hitl-orchestrator.service';

// Remediation service for creating remediation plans
import { remediationService } from '../services/epub/remediation.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPhase(state: string): WorkflowStatusResponse['phase'] {
  switch (state) {
    case WorkflowState.UPLOAD_RECEIVED:
    case WorkflowState.PREPROCESSING:
      return 'ingest';
    case WorkflowState.RUNNING_EPUBCHECK:
    case WorkflowState.RUNNING_ACE:
    case WorkflowState.RUNNING_AI_ANALYSIS:
    case WorkflowState.AWAITING_AI_REVIEW:
      return 'audit';
    case WorkflowState.AUTO_REMEDIATION:
    case WorkflowState.AWAITING_REMEDIATION_REVIEW:
    case WorkflowState.VERIFICATION_AUDIT:
      return 'remediate';
    case WorkflowState.CONFORMANCE_MAPPING:
    case WorkflowState.AWAITING_CONFORMANCE_REVIEW:
    case WorkflowState.ACR_GENERATION:
    case WorkflowState.AWAITING_ACR_SIGNOFF:
      return 'certify';
    case WorkflowState.COMPLETED:
      return 'complete';
    default:
      return 'failed';
  }
}

const STATE_PROGRESS: Record<string, number> = {
  [WorkflowState.UPLOAD_RECEIVED]: 5,
  [WorkflowState.PREPROCESSING]: 10,
  [WorkflowState.RUNNING_EPUBCHECK]: 20,
  [WorkflowState.RUNNING_ACE]: 30,
  [WorkflowState.RUNNING_AI_ANALYSIS]: 40,
  [WorkflowState.AWAITING_AI_REVIEW]: 45,
  [WorkflowState.AUTO_REMEDIATION]: 55,
  [WorkflowState.AWAITING_REMEDIATION_REVIEW]: 60,
  [WorkflowState.VERIFICATION_AUDIT]: 70,
  [WorkflowState.CONFORMANCE_MAPPING]: 75,
  [WorkflowState.AWAITING_CONFORMANCE_REVIEW]: 80,
  [WorkflowState.ACR_GENERATION]: 85,
  [WorkflowState.AWAITING_ACR_SIGNOFF]: 90,
  [WorkflowState.COMPLETED]: 100,
  [WorkflowState.FAILED]: 0,
  [WorkflowState.RETRYING]: 0,
  [WorkflowState.CANCELLED]: 0,
  [WorkflowState.HITL_TIMEOUT]: 0,
  [WorkflowState.PAUSED]: 0,
};

function badRequest(res: Response, message: string, details?: unknown) {
  return res.status(400).json({ success: false, error: { message, details } });
}

function serverError(res: Response, err: unknown, code: string) {
  logger.error(`[WorkflowController] ${code}`, err);
  return res.status(500).json({
    success: false,
    error: {
      code,
      message: err instanceof Error ? err.message : 'Internal server error',
    },
  });
}

// ── Controller ────────────────────────────────────────────────────────────────

class WorkflowController {
  /** POST /workflows */
  async startWorkflow(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const parsed = startWorkflowSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid request body', parsed.error.flatten());
        return;
      }
      const { fileId } = parsed.data;
      const workflow = await workflowService.createWorkflow(fileId, req.user!.id);
      res.status(201).json({ workflowId: workflow.id, currentState: workflow.currentState });
    } catch (err) {
      serverError(res, err, 'START_WORKFLOW_FAILED');
    }
  }

  /** GET /workflows/:id */
  async getWorkflowStatus(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const parsed = workflowParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        badRequest(res, 'Invalid workflow ID', parsed.error.flatten());
        return;
      }
      const { id } = parsed.data;
      const workflow = await workflowService.getWorkflow(id);

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      const response: WorkflowStatusResponse = {
        id: workflow.id,
        fileId: workflow.fileId,
        currentState: workflow.currentState as WorkflowState,
        phase: getPhase(workflow.currentState),
        progress: STATE_PROGRESS[workflow.currentState] ?? 0,
        startedAt: workflow.startedAt instanceof Date
          ? workflow.startedAt.toISOString()
          : workflow.startedAt,
        completedAt: workflow.completedAt
          ? (workflow.completedAt instanceof Date
            ? workflow.completedAt.toISOString()
            : workflow.completedAt)
          : undefined,
        errorMessage: workflow.errorMessage ?? undefined,
        retryCount: workflow.retryCount,
        loopCount: workflow.loopCount,
        createdBy: workflow.createdBy,
        batchId: workflow.batchId ?? undefined,
        stateData: workflow.stateData as Record<string, unknown> | undefined,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (err) {
      serverError(res, err, 'GET_WORKFLOW_FAILED');
    }
  }

  /** POST /workflows/:id/pause */
  async pauseWorkflow(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      await workflowService.transition(id, 'PAUSE');
      res.status(200).json({ message: 'Workflow paused' });
    } catch (err) {
      serverError(res, err, 'PAUSE_WORKFLOW_FAILED');
    }
  }

  /** POST /workflows/:id/resume */
  async resumeWorkflow(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      await workflowService.transition(id, 'RESUME');
      res.status(200).json({ message: 'Workflow resumed' });
    } catch (err) {
      serverError(res, err, 'RESUME_WORKFLOW_FAILED');
    }
  }

  /** POST /workflows/:id/cancel */
  async cancelWorkflow(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      await workflowService.transition(id, 'CANCEL');
      res.status(200).json({ message: 'Workflow cancelled' });
    } catch (err) {
      serverError(res, err, 'CANCEL_WORKFLOW_FAILED');
    }
  }

  /** POST /workflows/:id/retry */
  async retryWorkflow(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      await workflowService.transition(id, 'RETRY');
      res.status(200).json({ message: 'Workflow retry initiated' });
    } catch (err) {
      serverError(res, err, 'RETRY_WORKFLOW_FAILED');
    }
  }

  /** GET /workflows/:id/timeline */
  async getTimeline(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const events = await prisma.workflowEvent.findMany({
        where: { workflowId: id },
        orderBy: { timestamp: 'desc' },
      });

      logger.info(`[Timeline] Found ${events.length} events for workflow ${id}`);

      // Map database fields to frontend interface
      const mappedEvents = events.map(event => ({
        id: event.id,
        workflowId: event.workflowId,
        type: event.eventType,
        from: event.fromState || undefined,
        to: event.toState || undefined,
        timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
        metadata: event.payload as Record<string, unknown> | undefined,
      }));

      logger.info(`[Timeline] Returning ${mappedEvents.length} mapped events`);

      res.status(200).json({
        success: true,
        data: { workflowId: id, events: mappedEvents },
      });
    } catch (err) {
      serverError(res, err, 'GET_TIMELINE_FAILED');
    }
  }

  /** POST /workflows/:id/hitl/ai-review */
  async submitAIReview(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parsed = aiReviewDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid AI review payload', parsed.error.flatten());
        return;
      }
      const { decisions } = parsed.data;

      // Get workflow
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id },
      });

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      // Store AI review decisions in workflow state
      await prisma.workflowInstance.update({
        where: { id },
        data: {
          stateData: {
            ...(workflow.stateData as Record<string, unknown>),
            aiReviewDecisions: decisions,
            aiReviewedBy: req.user!.id,
            aiReviewedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[WorkflowController] AI Review completed for workflow ${id} by user ${req.user!.id}`);
      logger.info(`[WorkflowController] Decisions: ${decisions.length} items reviewed`);

      // Create remediation plan before transitioning to AUTO_REMEDIATION
      const stateData = workflow.stateData as { jobId?: string };
      if (stateData.jobId) {
        logger.info(`[WorkflowController] Creating remediation plan for job ${stateData.jobId}`);
        await remediationService.createRemediationPlan(stateData.jobId);
        logger.info(`[WorkflowController] Remediation plan created successfully`);
      } else {
        logger.warn(`[WorkflowController] No jobId found in workflow state, skipping remediation plan creation`);
      }

      // Transition workflow to continue (AWAITING_AI_REVIEW -> AUTO_REMEDIATION)
      await workflowService.transition(id, 'AI_ACCEPTED');

      // Trigger workflow agent to process the new AUTO_REMEDIATION state
      const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');
      // Run async without blocking response
      workflowAgentService.processWorkflowState(id).catch(err => {
        logger.error(`[WorkflowController] Failed to process AUTO_REMEDIATION state for ${id}`, err);
      });

      res.status(200).json({
        success: true,
        gateComplete: true,
        message: 'AI Review submitted successfully',
      });
    } catch (err) {
      serverError(res, err, 'SUBMIT_AI_REVIEW_FAILED');
    }
  }

  /** POST /workflows/:id/hitl/remediation-fix */
  async submitRemediationFix(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parsed = remediationFixSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid remediation fix payload', parsed.error.flatten());
        return;
      }
      const { itemId, fixDetail } = parsed.data;

      await prisma.remediationItem.update({
        where: { id: itemId },
        data: {
          manualFixApplied: true,
          manualFixDetail: fixDetail as object,
          fixedBy: req.user!.id,
          fixedAt: new Date(),
        },
      });

      await hitlOrchestratorService.submitDecisions(
        id,
        HITLGate.REMEDIATION_REVIEW,
        [{ itemId, decision: HITLAction.MANUAL_FIX, modifiedValue: fixDetail }],
        req.user!.id,
        async (event: string) => {
          await workflowService.transition(id, event);
        },
      );

      res.status(200).json({ success: true });
    } catch (err) {
      serverError(res, err, 'SUBMIT_REMEDIATION_FIX_FAILED');
    }
  }

  /** POST /workflows/:id/hitl/remediation-review */
  async submitRemediationReview(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parsed = remediationReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid remediation review payload', parsed.error.flatten());
        return;
      }
      const { notes } = parsed.data;

      // Get workflow
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id },
      });

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      // Store remediation review acceptance in workflow state
      await prisma.workflowInstance.update({
        where: { id },
        data: {
          stateData: {
            ...(workflow.stateData as Record<string, unknown>),
            remediationReviewNotes: notes,
            remediationReviewedBy: req.user!.id,
            remediationReviewedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[WorkflowController] Remediation review accepted for workflow ${id} by user ${req.user!.id}`);

      // Transition workflow to continue (AWAITING_REMEDIATION_REVIEW -> VERIFICATION_AUDIT)
      await workflowService.transition(id, 'REMEDIATION_APPROVED');

      // Trigger workflow agent to process the new VERIFICATION_AUDIT state
      const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');
      // Run async without blocking response
      workflowAgentService.processWorkflowState(id).catch(err => {
        logger.error(`[WorkflowController] Failed to process VERIFICATION_AUDIT state for ${id}`, err);
      });

      res.status(200).json({
        success: true,
        gateComplete: true,
        message: 'Remediation review accepted successfully',
      });
    } catch (err) {
      serverError(res, err, 'SUBMIT_REMEDIATION_REVIEW_FAILED');
    }
  }

  /** POST /workflows/:id/hitl/conformance-review */
  async submitConformanceReview(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parsed = conformanceReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid conformance review payload', parsed.error.flatten());
        return;
      }
      const { decisions } = parsed.data;

      // Get workflow
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id },
      });

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      // Store conformance review decisions in workflow state
      await prisma.workflowInstance.update({
        where: { id },
        data: {
          stateData: {
            ...(workflow.stateData as Record<string, unknown>),
            conformanceReviewDecisions: decisions,
            conformanceReviewedBy: req.user!.id,
            conformanceReviewedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[WorkflowController] Conformance Review completed for workflow ${id} by user ${req.user!.id}`);
      logger.info(`[WorkflowController] Decisions: ${decisions.length} criteria reviewed`);

      // Transition workflow to continue (AWAITING_CONFORMANCE_REVIEW -> ACR_GENERATION)
      await workflowService.transition(id, 'CONFORMANCE_APPROVED');

      // Trigger workflow agent to process the new ACR_GENERATION state
      const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');
      await workflowAgentService.processWorkflowState(id);

      res.status(200).json({ success: true, gateComplete: true });
    } catch (err) {
      serverError(res, err, 'SUBMIT_CONFORMANCE_REVIEW_FAILED');
    }
  }

  /** POST /workflows/:id/hitl/acr-signoff */
  async submitACRSignoff(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parsed = acrSignoffSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid ACR sign-off payload', parsed.error.flatten());
        return;
      }
      const { attestation, notes } = parsed.data as { attestation: { text: string; confirmed: boolean }; notes?: string };

      if (attestation.confirmed !== true) {
        badRequest(res, 'Attestation must be confirmed');
        return;
      }

      // Get workflow
      const workflow = await prisma.workflowInstance.findUnique({
        where: { id },
      });

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      // Store ACR signoff in workflow state
      await prisma.workflowInstance.update({
        where: { id },
        data: {
          stateData: {
            ...(workflow.stateData as Record<string, unknown>),
            acrSignoffAttestation: attestation,
            acrSignoffNotes: notes,
            acrSignedOffBy: req.user!.id,
            acrSignedOffAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[WorkflowController] ACR Sign-Off completed for workflow ${id} by user ${req.user!.id}`);

      // Transition workflow to complete (AWAITING_ACR_SIGNOFF -> COMPLETED)
      await workflowService.transition(id, 'ACR_SIGNED');

      // Trigger workflow agent to process the COMPLETED state
      const { workflowAgentService } = await import('../services/workflow/workflow-agent.service');
      await workflowAgentService.processWorkflowState(id);

      res.status(200).json({ message: 'ACR signed off successfully', success: true });
    } catch (err) {
      serverError(res, err, 'SUBMIT_ACR_SIGNOFF_FAILED');
    }
  }

  /** POST /workflows/batch */
  async startBatch(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const parsed = startBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, 'Invalid batch payload', parsed.error.flatten());
        return;
      }
      const { name, fileIds, concurrency, autoApprovalPolicy } = parsed.data;
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;

      // Validate auto-approval policy against tenant settings
      if (autoApprovalPolicy) {
        const tenantConfig = await workflowConfigService.getEffectiveConfig(tenantId);
        const allowFullyHeadless = tenantConfig.batchPolicy?.allowFullyHeadless ?? false;

        if (!allowFullyHeadless) {
          // Require at least one gate to use 'require-manual'
          const gates = autoApprovalPolicy.gates;
          const allAutoAccept = (
            (gates.AI_REVIEW ?? 'require-manual') === 'auto-accept' &&
            (gates.REMEDIATION_REVIEW ?? 'require-manual') === 'auto-accept' &&
            (gates.CONFORMANCE_REVIEW ?? 'require-manual') === 'auto-accept' &&
            (gates.ACR_SIGNOFF ?? 'require-manual') === 'auto-accept'
          );

          if (allAutoAccept) {
            badRequest(
              res,
              'Fully headless batches (all gates auto-accept) are not permitted for this tenant. ' +
              'At least one HITL gate must remain as require-manual, or contact your administrator to enable fully headless mode.',
              {}
            );
            return;
          }
        }
      }

      const batch = await prisma.batchWorkflow.create({
        data: {
          name,
          totalFiles: fileIds.length,
          concurrency,
          status: 'PENDING',
          createdBy: userId,
          ...(autoApprovalPolicy ? { autoApprovalPolicy: autoApprovalPolicy as unknown as Prisma.InputJsonValue } : {}),
        },
      });

      await Promise.all(
        fileIds.map((fileId: string) =>
          workflowService.createWorkflow(fileId, userId, batch.id),
        ),
      );

      res.status(201).json({
        batchId: batch.id,
        workflowCount: fileIds.length,
        autoApprovalPolicy: autoApprovalPolicy ?? null,
      });
    } catch (err) {
      serverError(res, err, 'START_BATCH_FAILED');
    }
  }

  /** POST /workflows/batch/:batchId/pause */
  async pauseBatch(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { batchId } = req.params;

      const batch = await prisma.batchWorkflow.findUnique({
        where: { id: batchId },
        include: { workflows: { select: { id: true, currentState: true } } },
      });

      if (!batch) {
        res.status(404).json({ success: false, error: { message: 'Batch not found' } });
        return;
      }

      if (['COMPLETED', 'CANCELLED'].includes(batch.status)) {
        badRequest(res, `Cannot pause a batch in ${batch.status} status`, {});
        return;
      }

      const NON_TERMINAL = [
        'UPLOAD_RECEIVED', 'PREPROCESSING', 'RUNNING_EPUBCHECK', 'RUNNING_ACE',
        'RUNNING_AI_ANALYSIS', 'AWAITING_AI_REVIEW', 'AUTO_REMEDIATION',
        'AWAITING_REMEDIATION_REVIEW', 'VERIFICATION_AUDIT', 'CONFORMANCE_MAPPING',
        'AWAITING_CONFORMANCE_REVIEW', 'ACR_GENERATION', 'AWAITING_ACR_SIGNOFF', 'RETRYING',
      ];

      const pauseable = batch.workflows.filter(w => NON_TERMINAL.includes(w.currentState));

      const { enqueueWorkflowEvent } = await import('../queues/workflow.queue');
      await Promise.all(pauseable.map(w => enqueueWorkflowEvent(w.id, 'PAUSE')));

      await prisma.batchWorkflow.update({
        where: { id: batchId },
        data: { status: 'PAUSED' },
      });

      res.status(200).json({
        success: true,
        pausedCount: pauseable.length,
        message: `Paused ${pauseable.length} workflows in batch`,
      });
    } catch (err) {
      serverError(res, err, 'PAUSE_BATCH_FAILED');
    }
  }

  /** POST /workflows/batch/:batchId/resume */
  async resumeBatch(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { batchId } = req.params;

      const batch = await prisma.batchWorkflow.findUnique({
        where: { id: batchId },
        include: { workflows: { select: { id: true, currentState: true } } },
      });

      if (!batch) {
        res.status(404).json({ success: false, error: { message: 'Batch not found' } });
        return;
      }

      if (batch.status !== 'PAUSED') {
        badRequest(res, `Batch is not paused (current status: ${batch.status})`, {});
        return;
      }

      const paused = batch.workflows.filter(w => w.currentState === 'PAUSED');

      const { enqueueWorkflowEvent } = await import('../queues/workflow.queue');
      await Promise.all(paused.map(w => enqueueWorkflowEvent(w.id, 'RESUME')));

      await prisma.batchWorkflow.update({
        where: { id: batchId },
        data: { status: 'PROCESSING' },
      });

      res.status(200).json({
        success: true,
        resumedCount: paused.length,
        message: `Resumed ${paused.length} workflows in batch`,
      });
    } catch (err) {
      serverError(res, err, 'RESUME_BATCH_FAILED');
    }
  }

  /** POST /workflows/batch/:batchId/retry-failed */
  async retryFailedBatch(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { batchId } = req.params;

      const batch = await prisma.batchWorkflow.findUnique({
        where: { id: batchId },
        include: { workflows: { select: { id: true, currentState: true } } },
      });

      if (!batch) {
        res.status(404).json({ success: false, error: { message: 'Batch not found' } });
        return;
      }

      const failed = batch.workflows.filter(w => w.currentState === 'FAILED');

      if (failed.length === 0) {
        res.status(200).json({ success: true, retriedCount: 0, message: 'No failed workflows to retry' });
        return;
      }

      const { enqueueWorkflowEvent } = await import('../queues/workflow.queue');
      await Promise.all(failed.map(w => enqueueWorkflowEvent(w.id, 'RETRY')));

      // Set batch back to processing if it was in a terminal-ish state
      if (['PAUSED', 'COMPLETED'].includes(batch.status)) {
        await prisma.batchWorkflow.update({
          where: { id: batchId },
          data: { status: 'PROCESSING' },
        });
      }

      res.status(200).json({
        success: true,
        retriedCount: failed.length,
        message: `Retrying ${failed.length} failed workflows in batch`,
      });
    } catch (err) {
      serverError(res, err, 'RETRY_FAILED_BATCH_FAILED');
    }
  }

  /** GET /workflows/batch/:batchId */
  async getBatchDashboard(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { batchId } = req.params;
      const batch = await prisma.batchWorkflow.findUnique({
        where: { id: batchId },
        include: { workflows: { select: { currentState: true } } },
      });

      if (!batch) {
        res.status(404).json({ success: false, error: { message: 'Batch not found' } });
        return;
      }

      const perStage: Record<string, number> = {};
      const perGate: Record<string, number> = {
        [HITLGate.AI_REVIEW]: 0,
        [HITLGate.REMEDIATION_REVIEW]: 0,
        [HITLGate.CONFORMANCE_REVIEW]: 0,
        [HITLGate.ACR_SIGNOFF]: 0,
      };
      let completedCount = 0;
      let failedCount = 0;
      let errorCount = 0;

      for (const wf of batch.workflows) {
        const state = wf.currentState;
        perStage[state] = (perStage[state] ?? 0) + 1;
        if (state === WorkflowState.AWAITING_AI_REVIEW) perGate[HITLGate.AI_REVIEW]++;
        if (state === WorkflowState.AWAITING_REMEDIATION_REVIEW) perGate[HITLGate.REMEDIATION_REVIEW]++;
        if (state === WorkflowState.AWAITING_CONFORMANCE_REVIEW) perGate[HITLGate.CONFORMANCE_REVIEW]++;
        if (state === WorkflowState.AWAITING_ACR_SIGNOFF) perGate[HITLGate.ACR_SIGNOFF]++;
        if (state === WorkflowState.COMPLETED) completedCount++;
        if (state === WorkflowState.FAILED || state === WorkflowState.CANCELLED) failedCount++;
        if (state === WorkflowState.FAILED) errorCount++;
      }

      res.status(200).json({
        id: batch.id,
        name: batch.name,
        totalFiles: batch.totalFiles,
        status: batch.status,
        metrics: {
          perStage,
          perGate,
          completedCount,
          failedCount,
          errorCount,
        },
        startedAt: batch.startedAt.toISOString(),
        completedAt: batch.completedAt?.toISOString(),
        autoApprovalPolicy: (batch.autoApprovalPolicy as BatchAutoApprovalPolicy | null) ?? null,
      });
    } catch (err) {
      serverError(res, err, 'GET_BATCH_DASHBOARD_FAILED');
    }
  }
}

export const workflowController = new WorkflowController();
