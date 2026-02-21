/**
 * @fileoverview Workflow automation agent.
 * Processes workflow state transitions and triggers appropriate actions.
 * Handles automated progression through audit, remediation, and ACR generation.
 */

import { WorkflowInstance, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { enqueueWorkflowEvent } from '../../queues/workflow.queue';
import { workflowService } from './workflow.service';

/**
 * Workflow automation agent service.
 * Listens for workflow state changes and triggers appropriate automated actions.
 */
class WorkflowAgentService {
  /**
   * Process a workflow after state transition.
   * Routes to appropriate handler based on current state.
   *
   * @param workflowId - Workflow instance ID
   */
  async processWorkflowState(workflowId: string): Promise<void> {
    try {
      const workflow = await workflowService.getWorkflow(workflowId);
      if (!workflow) {
        logger.warn(`[WorkflowAgent] Workflow ${workflowId} not found`);
        return;
      }

      logger.info(`[WorkflowAgent] Processing state: ${workflow.currentState} for workflow ${workflowId}`);

      // Route to appropriate handler
      switch (workflow.currentState) {
        case 'UPLOAD_RECEIVED':
          await this.handleUploadReceived(workflow);
          break;

        case 'PREPROCESSING':
          await this.handlePreprocessing(workflow);
          break;

        case 'RUNNING_EPUBCHECK':
          await this.handleRunningEpubcheck(workflow);
          break;

        case 'RUNNING_ACE':
          await this.handleRunningAce(workflow);
          break;

        case 'RUNNING_AI_ANALYSIS':
          await this.handleRunningAiAnalysis(workflow);
          break;

        case 'AWAITING_AI_REVIEW':
          await this.handleAwaitingAiReview(workflow);
          break;

        case 'AUTO_REMEDIATION':
          await this.handleAutoRemediation(workflow);
          break;

        case 'AWAITING_REMEDIATION_REVIEW':
          await this.handleAwaitingRemediationReview(workflow);
          break;

        case 'VERIFICATION_AUDIT':
          await this.handleVerificationAudit(workflow);
          break;

        case 'CONFORMANCE_MAPPING':
          await this.handleConformanceMapping(workflow);
          break;

        case 'AWAITING_CONFORMANCE_REVIEW':
          await this.handleAwaitingConformanceReview(workflow);
          break;

        case 'ACR_GENERATION':
          await this.handleAcrGeneration(workflow);
          break;

        case 'AWAITING_ACR_SIGNOFF':
          await this.handleAwaitingAcrSignoff(workflow);
          break;

        case 'COMPLETED':
        case 'FAILED':
        case 'CANCELLED':
        case 'PAUSED':
        case 'HITL_TIMEOUT':
          // Terminal or paused states - no automated action
          logger.info(`[WorkflowAgent] Terminal/paused state: ${workflow.currentState}`);
          break;

        default:
          logger.warn(`[WorkflowAgent] No handler for state: ${workflow.currentState}`);
      }
    } catch (error) {
      logger.error(`[WorkflowAgent] Error processing workflow ${workflowId}:`, error);

      // Transition to FAILED state
      try {
        await workflowService.transition(workflowId, 'ERROR', {
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          failedAt: new Date().toISOString(),
        });
      } catch (transitionError) {
        logger.error(`[WorkflowAgent] Failed to transition to ERROR state:`, transitionError);
      }
    }
  }

  /**
   * Handle UPLOAD_RECEIVED state.
   * Automatically triggers preprocessing.
   */
  private async handleUploadReceived(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Auto-triggering preprocessing for workflow ${workflow.id}`);
    await enqueueWorkflowEvent(workflow.id, 'PREPROCESS');
  }

  /**
   * Handle PREPROCESSING state.
   * Prepares file and triggers initial audit (EPUBCheck or Matterhorn).
   */
  private async handlePreprocessing(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Preprocessing workflow ${workflow.id}`);

    // Get file to determine type
    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found`);
    }

    // Store file metadata in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          mimeType: file.mimeType,
          filename: file.filename,
          preprocessedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Preprocessing complete, triggering audit for ${file.mimeType}`);

    // Trigger appropriate audit based on file type
    await enqueueWorkflowEvent(workflow.id, 'START_AUDIT');
  }

  /**
   * Handle RUNNING_EPUBCHECK state.
   * Triggers EPUBCheck/Matterhorn validation.
   *
   * NOTE: Actual audit execution happens in job processor.
   * This handler waits for audit completion, then triggers next step.
   */
  private async handleRunningEpubcheck(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running initial audit for workflow ${workflow.id}`);

    // NOTE: Actual audit is triggered by job processor
    // This is placeholder - actual integration will query job status
    // For now, auto-advance after delay (to be replaced with job completion webhook)

    logger.info(`[WorkflowAgent] Initial audit completed (placeholder), triggering ACE`);
    await enqueueWorkflowEvent(workflow.id, 'ACE_START');
  }

  /**
   * Handle RUNNING_ACE state.
   * Triggers ACE (Accessibility Checker for EPUB) audit.
   */
  private async handleRunningAce(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running ACE audit for workflow ${workflow.id}`);

    // NOTE: Actual ACE audit is triggered by job processor
    // This is placeholder - actual integration will query job status

    logger.info(`[WorkflowAgent] ACE audit completed (placeholder), triggering AI analysis`);
    await enqueueWorkflowEvent(workflow.id, 'AI_START');
  }

  /**
   * Handle RUNNING_AI_ANALYSIS state.
   * Triggers AI-powered accessibility analysis.
   */
  private async handleRunningAiAnalysis(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running AI analysis for workflow ${workflow.id}`);

    // NOTE: Actual AI analysis is triggered by job processor
    // This is placeholder - actual integration will query job status

    logger.info(`[WorkflowAgent] AI analysis completed (placeholder), moving to review gate`);
    await enqueueWorkflowEvent(workflow.id, 'AI_DONE');
  }

  /**
   * Handle AWAITING_AI_REVIEW state (HITL gate).
   * This is a Human-in-the-Loop gate - no automated action.
   * Timeout service will auto-advance if configured, or manual approval required.
   */
  private async handleAwaitingAiReview(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Workflow ${workflow.id} awaiting AI review (HITL gate)`);
    // No automated action - HITL gate handles this
  }

  /**
   * Handle AUTO_REMEDIATION state.
   * Triggers automated accessibility fixes.
   */
  private async handleAutoRemediation(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running auto-remediation for workflow ${workflow.id}`);

    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found`);
    }

    // NOTE: Actual remediation is triggered by job processor
    // This is placeholder - actual integration will call remediation service

    logger.info(`[WorkflowAgent] Auto-remediation completed (placeholder)`);
    await enqueueWorkflowEvent(workflow.id, 'REMEDIATION_DONE');
  }

  /**
   * Handle AWAITING_REMEDIATION_REVIEW state (HITL gate).
   * This is a Human-in-the-Loop gate - no automated action.
   */
  private async handleAwaitingRemediationReview(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Workflow ${workflow.id} awaiting remediation review (HITL gate)`);
    // No automated action - HITL gate handles this
  }

  /**
   * Handle VERIFICATION_AUDIT state.
   * Re-audits the remediated file to verify fixes.
   */
  private async handleVerificationAudit(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running verification audit for workflow ${workflow.id}`);

    // NOTE: Actual verification audit is triggered by job processor
    // This is placeholder - actual integration will re-run audit on remediated file

    logger.info(`[WorkflowAgent] Verification audit completed (placeholder)`);
    await enqueueWorkflowEvent(workflow.id, 'CONFORMANCE_START');
  }

  /**
   * Handle CONFORMANCE_MAPPING state.
   * Maps accessibility issues to WCAG/Section 508 criteria.
   */
  private async handleConformanceMapping(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running conformance mapping for workflow ${workflow.id}`);

    // NOTE: Actual conformance mapping happens in ACR service
    // This is placeholder - actual integration will map issues to standards

    logger.info(`[WorkflowAgent] Conformance mapping completed (placeholder)`);
    await enqueueWorkflowEvent(workflow.id, 'CONFORMANCE_DONE');
  }

  /**
   * Handle AWAITING_CONFORMANCE_REVIEW state (HITL gate).
   * This is a Human-in-the-Loop gate - no automated action.
   */
  private async handleAwaitingConformanceReview(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Workflow ${workflow.id} awaiting conformance review (HITL gate)`);
    // No automated action - HITL gate handles this
  }

  /**
   * Handle ACR_GENERATION state.
   * Generates Accessibility Conformance Report (ACR/VPAT).
   */
  private async handleAcrGeneration(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Generating ACR for workflow ${workflow.id}`);

    // Get file to access tenant info
    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found`);
    }

    // Get latest job associated with this workflow
    // Jobs store fileId in their input JSON field
    const jobs = await prisma.job.findMany({
      where: { tenantId: file.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Find job that references this file in its input
    const job = jobs.find(j => {
      const input = j.input as { fileId?: string };
      return input.fileId === workflow.fileId;
    });

    if (!job) {
      logger.warn(`[WorkflowAgent] No job found for file ${workflow.fileId}, skipping ACR generation`);
      // Continue workflow without ACR
      await enqueueWorkflowEvent(workflow.id, 'ACR_DONE');
      return;
    }

    // NOTE: Actual ACR generation is triggered by ACR service
    // This is placeholder - actual integration will call acrGeneratorService

    logger.info(`[WorkflowAgent] ACR generation completed (placeholder)`);

    // Store ACR reference in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          acrGeneratedAt: new Date().toISOString(),
          jobId: job.id,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await enqueueWorkflowEvent(workflow.id, 'ACR_DONE');
  }

  /**
   * Handle AWAITING_ACR_SIGNOFF state (HITL gate).
   * This is a Human-in-the-Loop gate - typically no timeout (manual approval required).
   */
  private async handleAwaitingAcrSignoff(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Workflow ${workflow.id} awaiting ACR signoff (HITL gate - manual approval)`);
    // No automated action - manual approval required
  }
}

// Export singleton instance
export const workflowAgentService = new WorkflowAgentService();
