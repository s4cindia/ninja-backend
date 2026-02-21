/**
 * @fileoverview Workflow automation agent.
 * Processes workflow state transitions and triggers appropriate actions.
 * Handles automated progression through audit, remediation, and ACR generation.
 */

import { WorkflowInstance, Prisma, JobType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { enqueueWorkflowEvent } from '../../queues/workflow.queue';
import { workflowService } from './workflow.service';
import { s3Service } from '../s3.service';
import { epubAuditService } from '../epub/epub-audit.service';
import { pdfAuditService } from '../pdf/pdf-audit.service';
import { autoRemediationService } from '../epub/auto-remediation.service';
import { pdfAutoRemediationService } from '../pdf/pdf-auto-remediation.service';
import { acrService } from '../acr.service';

/**
 * Workflow automation agent service.
 * Listens for workflow state changes and triggers appropriate automated actions.
 */
class WorkflowAgentService {
  /**
   * Helper: Get file buffer from S3 or local storage.
   */
  private async getFileBuffer(file: { storageType: string; storagePath: string | null; path: string }): Promise<Buffer> {
    if (file.storageType === 'S3' && file.storagePath) {
      return await s3Service.getFileBuffer(file.storagePath);
    } else {
      // Local storage
      const fs = await import('fs/promises');
      return await fs.readFile(file.path);
    }
  }

  /**
   * Helper: Save remediated file to S3 or local storage.
   * Returns the storage path where file was saved.
   */
  private async saveRemediatedFile(
    buffer: Buffer,
    originalFile: { storageType: string; storagePath: string | null; path: string; filename: string; tenantId: string; mimeType: string },
    suffix: string = '-remediated'
  ): Promise<string> {
    const path = await import('path');
    const ext = path.extname(originalFile.filename);
    const baseName = path.basename(originalFile.filename, ext);
    const remediatedFilename = `${baseName}${suffix}${ext}`;

    if (originalFile.storageType === 'S3' && originalFile.storagePath) {
      // S3 storage
      const fileKey = await s3Service.uploadBuffer(
        originalFile.tenantId,
        remediatedFilename,
        buffer,
        originalFile.mimeType,
        'remediated'
      );
      logger.info(`[WorkflowAgent] Saved remediated file to S3: ${fileKey}`);
      return fileKey;
    } else {
      // Local storage
      const fs = await import('fs/promises');
      const dir = path.dirname(originalFile.path);
      const remediatedPath = path.join(dir, remediatedFilename);
      await fs.writeFile(remediatedPath, buffer);
      logger.info(`[WorkflowAgent] Saved remediated file locally: ${remediatedPath}`);
      return remediatedPath;
    }
  }

  /**
   * Helper: Create or get existing job for workflow.
   */
  private async getOrCreateJob(
    workflow: WorkflowInstance,
    file: { id: string; tenantId: string; filename: string; mimeType: string },
    userId: string,
    jobType: JobType
  ): Promise<{ id: string; isNew: boolean }> {
    // Check if job already exists in workflow state
    const stateData = workflow.stateData as { jobId?: string };
    if (stateData.jobId) {
      return { id: stateData.jobId, isNew: false };
    }

    // Create new job
    const job = await prisma.job.create({
      data: {
        tenantId: file.tenantId,
        userId,
        type: jobType,
        status: 'PROCESSING',
        priority: 0,
        input: {
          fileId: file.id,
          filename: file.filename,
          workflowId: workflow.id,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Store job ID in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          jobId: job.id,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Created job ${job.id} for workflow ${workflow.id}`);
    return { id: job.id, isNew: true };
  }
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
   * Triggers EPUBCheck/Matterhorn/ACE validation (all in one call).
   */
  private async handleRunningEpubcheck(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running accessibility audit for workflow ${workflow.id}`);

    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found`);
    }

    // Get or create job
    const isEpub = file.mimeType.includes('epub');
    const jobType: JobType = isEpub ? 'EPUB_ACCESSIBILITY' : 'PDF_ACCESSIBILITY';
    const jobInfo = await this.getOrCreateJob(workflow, file, workflow.createdBy, jobType);

    // Get file buffer
    const buffer = await this.getFileBuffer(file);

    logger.info(`[WorkflowAgent] Running ${jobType} for file ${file.filename}`);

    // Run appropriate audit
    let auditResult;
    if (isEpub) {
      auditResult = await epubAuditService.runAudit(buffer, jobInfo.id, file.filename);
    } else {
      auditResult = await pdfAuditService.runAuditFromBuffer(buffer, jobInfo.id, file.filename);
    }

    // Update job with results
    await prisma.job.update({
      where: { id: jobInfo.id },
      data: {
        status: 'COMPLETED',
        output: auditResult as unknown as Prisma.InputJsonValue,
        progress: 100,
        completedAt: new Date(),
      },
    });

    // Store audit results in workflow state
    const issueCount = 'combinedIssues' in auditResult
      ? auditResult.combinedIssues?.length || 0
      : auditResult.issues?.length || 0;

    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          auditCompleted: true,
          auditScore: auditResult.score,
          issueCount,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Audit completed: score=${auditResult.score}, issues=${issueCount}`);

    // Trigger ACE_START to follow state machine (ACE is already included in audit)
    await enqueueWorkflowEvent(workflow.id, 'ACE_START');
  }

  /**
   * Handle RUNNING_ACE state.
   * ACE is already included in EPUBCheck handler, so just trigger AI analysis.
   */
  private async handleRunningAce(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] ACE audit already included in initial audit for workflow ${workflow.id}`);

    // ACE results are part of the combined audit
    // Just trigger AI analysis
    await enqueueWorkflowEvent(workflow.id, 'AI_START');
  }

  /**
   * Handle RUNNING_AI_ANALYSIS state.
   * AI analysis is typically integrated into the audit itself.
   * This step can be used for additional AI enrichment if needed.
   */
  private async handleRunningAiAnalysis(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] AI analysis for workflow ${workflow.id}`);

    // AI analysis is already part of the audit service
    // (Gemini provides suggestions, severity analysis, etc.)
    // This step can be extended for additional AI processing if needed

    logger.info(`[WorkflowAgent] AI analysis complete, moving to review gate`);
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

    // Get job ID from workflow state
    const stateData = workflow.stateData as { jobId?: string };
    if (!stateData.jobId) {
      throw new Error('Job ID not found in workflow state');
    }

    // Get original file buffer
    const buffer = await this.getFileBuffer(file);

    logger.info(`[WorkflowAgent] Running remediation for ${file.filename}`);

    // Run appropriate remediation service
    const isEpub = file.mimeType.includes('epub');

    if (isEpub) {
      // EPUB remediation
      const epubResult = await autoRemediationService.runAutoRemediation(
        buffer,
        stateData.jobId,
        file.filename
      );

      if (!epubResult.remediatedBuffer) {
        logger.warn(`[WorkflowAgent] No remediated buffer returned for EPUB, skipping save`);
      } else {
        // Save remediated file (S3 or local)
        const remediatedPath = await this.saveRemediatedFile(
          epubResult.remediatedBuffer,
          file,
          '-remediated'
        );

        // Store remediated file path in workflow state
        await prisma.workflowInstance.update({
          where: { id: workflow.id },
          data: {
            stateData: {
              ...(workflow.stateData as Record<string, unknown>),
              remediatedFilePath: remediatedPath,
              remediatedFileName: epubResult.remediatedFileName,
              totalIssuesFixed: epubResult.totalIssuesFixed,
              totalIssuesFailed: epubResult.totalIssuesFailed,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        logger.info(`[WorkflowAgent] EPUB auto-remediation completed: fixed=${epubResult.totalIssuesFixed}, failed=${epubResult.totalIssuesFailed}`);
      }
    } else {
      // PDF remediation
      const pdfResult = await pdfAutoRemediationService.runAutoRemediation(
        buffer,
        stateData.jobId,
        file.filename
      );

      if (!pdfResult.remediatedPdfBuffer) {
        logger.warn(`[WorkflowAgent] No remediated buffer returned for PDF, skipping save`);
      } else {
        // Save remediated file (S3 or local)
        const remediatedPath = await this.saveRemediatedFile(
          pdfResult.remediatedPdfBuffer,
          file,
          '-remediated'
        );

        // Store remediated file path in workflow state
        await prisma.workflowInstance.update({
          where: { id: workflow.id },
          data: {
            stateData: {
              ...(workflow.stateData as Record<string, unknown>),
              remediatedFilePath: remediatedPath,
              remediatedFileName: pdfResult.fileName,
              totalIssuesFixed: pdfResult.completedTasks,
              totalIssuesFailed: pdfResult.failedTasks,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        logger.info(`[WorkflowAgent] PDF auto-remediation completed: fixed=${pdfResult.completedTasks}, failed=${pdfResult.failedTasks}`);
      }
    }

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

    const file = await prisma.file.findUnique({
      where: { id: workflow.fileId },
    });

    if (!file) {
      throw new Error(`File ${workflow.fileId} not found`);
    }

    // Get remediated file path from workflow state
    const stateData = workflow.stateData as {
      jobId?: string;
      remediatedFilePath?: string;
      remediatedFileName?: string;
    };

    if (!stateData.remediatedFilePath) {
      logger.warn(`[WorkflowAgent] No remediated file found, skipping verification audit`);
      await enqueueWorkflowEvent(workflow.id, 'CONFORMANCE_START');
      return;
    }

    if (!stateData.jobId) {
      throw new Error('Job ID not found in workflow state');
    }

    // Get remediated file buffer
    const remediatedBuffer = await this.getFileBuffer({
      storageType: file.storageType,
      storagePath: file.storageType === 'S3' ? stateData.remediatedFilePath : null,
      path: stateData.remediatedFilePath,
    });

    logger.info(`[WorkflowAgent] Running verification audit on remediated file`);

    // Run audit on remediated file
    const isEpub = file.mimeType.includes('epub');
    let verificationResult;

    if (isEpub) {
      verificationResult = await epubAuditService.runAudit(
        remediatedBuffer,
        stateData.jobId,
        stateData.remediatedFileName || file.filename
      );
    } else {
      verificationResult = await pdfAuditService.runAuditFromBuffer(
        remediatedBuffer,
        stateData.jobId,
        stateData.remediatedFileName || file.filename
      );
    }

    // Update job with verification results
    await prisma.job.update({
      where: { id: stateData.jobId },
      data: {
        output: {
          ...(await prisma.job.findUnique({ where: { id: stateData.jobId } }).then(j => j?.output as Record<string, unknown>)),
          verificationAudit: verificationResult,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Store verification results in workflow state
    const issueCount = 'combinedIssues' in verificationResult
      ? verificationResult.combinedIssues?.length || 0
      : verificationResult.issues?.length || 0;

    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          verificationScore: verificationResult.score,
          verificationIssueCount: issueCount,
          verificationCompleted: true,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Verification audit completed: score=${verificationResult.score}, issues=${issueCount}`);
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

    // Generate ACR using ACR service
    // Use International Edition (VPAT2.5-INT) which satisfies US Section 508, EU EN 301 549, and WCAG
    const edition = 'VPAT2.5-INT';
    const documentTitle = file.filename;

    logger.info(`[WorkflowAgent] Creating ACR analysis: edition=${edition}, documentTitle=${documentTitle}`);

    const acrResult = await acrService.createAcrAnalysis(
      workflow.createdBy,
      file.tenantId,
      job.id,
      edition,
      documentTitle
    );

    logger.info(`[WorkflowAgent] ACR generated: acrJobId=${acrResult.acrJob.id}, criteria=${acrResult.criteriaCount}`);

    // Store ACR reference in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          acrJobId: acrResult.acrJob.id,
          acrEdition: edition,
          acrCriteriaCount: acrResult.criteriaCount,
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
