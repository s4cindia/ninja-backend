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
import { remediationService } from '../epub/remediation.service';
import { pdfAutoRemediationService } from '../pdf/pdf-auto-remediation.service';
import { pdfRemediationService } from '../pdf/pdf-remediation.service';
import { acrGeneratorService } from '../acr/acr-generator.service';
import type { AuditIssueInput } from '../acr/wcag-issue-mapper.service';
import { websocketService } from './websocket.service';
import { config } from '../../config';
import type {
  BatchAutoApprovalPolicy,
  ConditionalGatePolicy,
  PolicyConditions,
} from '../../types/workflow-contracts';
import { categorizeIssue } from './issue-categorizer.service';

/**
 * Workflow automation agent service.
 * Listens for workflow state changes and triggers appropriate automated actions.
 */
class WorkflowAgentService {
  /**
   * Helper: Retry a function with exponential backoff.
   * Used for transient failures (network, external services, etc.)
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
      operation?: string;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      initialDelayMs = 1000,
      maxDelayMs = 10000,
      operation = 'operation',
    } = options;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on last attempt
        if (attempt === maxRetries) {
          logger.error(`[WorkflowAgent] ${operation} failed after ${maxRetries + 1} attempts:`, lastError);
          throw lastError;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.warn(`[WorkflowAgent] ${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, lastError.message);

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

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

    // Check for existing completed job for this file
    const existingJobs = await prisma.job.findMany({
      where: {
        tenantId: file.tenantId,
        type: jobType,
        status: 'COMPLETED',
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Find job that references this file
    const existingJob = existingJobs.find(j => {
      const input = j.input as { fileId?: string };
      return input.fileId === file.id;
    });

    if (existingJob) {
      // Store existing job ID in workflow state
      await prisma.workflowInstance.update({
        where: { id: workflow.id },
        data: {
          stateData: {
            ...(workflow.stateData as Record<string, unknown>),
            jobId: existingJob.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      logger.info(`[WorkflowAgent] Found existing job ${existingJob.id} for workflow ${workflow.id}`);
      return { id: existingJob.id, isNew: false };
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

        case 'RETRYING':
          // Immediately advance to PREPROCESSING to restart the workflow
          logger.info(`[WorkflowAgent] Auto-advancing RETRYING workflow ${workflow.id} to PREPROCESSING`);
          await enqueueWorkflowEvent(workflow.id, 'RETRY_EXECUTE');
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
        const transitioned = await workflowService.transition(workflowId, 'ERROR', {
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          failedAt: new Date().toISOString(),
        });

        // Emit WebSocket error event using actual post-transition state
        if (config.features.enableWebSocket) {
          websocketService.emitError({
            workflowId,
            error: error instanceof Error ? error.message : String(error),
            state: transitioned.currentState as import('../../types/workflow-contracts').WorkflowState,
            retryable: true,
            retryCount: transitioned.retryCount,
          });
        }

        // Apply batch error strategy if this workflow belongs to a batch
        if (transitioned.batchId) {
          await this.handleBatchWorkflowError(transitioned, error);
        }
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

    // Check if job is already completed (audit already ran)
    const existingJob = await prisma.job.findUnique({
      where: { id: jobInfo.id },
      select: { status: true, output: true },
    });

    let auditResult;
    if (existingJob && existingJob.status === 'COMPLETED' && existingJob.output) {
      // Audit already completed - reuse results
      logger.info(`[WorkflowAgent] Reusing existing audit results from job ${jobInfo.id}`);
      auditResult = existingJob.output;
    } else {
      // Run audit with retry logic for transient failures
      const buffer = await this.getFileBuffer(file);
      logger.info(`[WorkflowAgent] Running ${jobType} for file ${file.filename}`);

      auditResult = await this.retryWithBackoff(
        async () => {
          if (isEpub) {
            return await epubAuditService.runAudit(buffer, jobInfo.id, file.filename);
          } else {
            return await pdfAuditService.runAuditFromBuffer(buffer, jobInfo.id, file.filename);
          }
        },
        {
          maxRetries: 2,
          initialDelayMs: 2000,
          operation: `${jobType} audit`,
        }
      );
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
    const auditData = auditResult as Record<string, unknown>;
    const issueCount = 'combinedIssues' in auditData
      ? (auditData.combinedIssues as unknown[] | undefined)?.length || 0
      : (auditData.issues as unknown[] | undefined)?.length || 0;

    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          jobId: jobInfo.id, // Store jobId for remediation phase
          auditCompleted: true,
          auditScore: auditData.score as number,
          issueCount,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Audit completed: score=${auditData.score}, issues=${issueCount}`);

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

    // Check if batch policy auto-approves this gate
    if (await this.shouldAutoApprove(workflow, 'AI_REVIEW')) {
      logger.info(`[WorkflowAgent] Auto-approving AI review for batch workflow ${workflow.id}`);
      await enqueueWorkflowEvent(workflow.id, 'AI_ACCEPTED', { autoApproved: true, batchAutoApproval: true });
      return;
    }

    // Emit WebSocket event to notify frontend
    if (config.features.enableWebSocket) {
      websocketService.emitHITLRequired({
        workflowId: workflow.id,
        gate: 'AI_REVIEW',
        itemCount: 0, // AI review items count (TODO: get actual count from workflow data)
        deepLink: `/workflow/${workflow.id}/hitl/ai-review`,
      });
    }
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

    // Ensure a remediation plan exists before running auto-remediation.
    // The plan is normally created by the old batch pipeline but must be
    // created explicitly in the agentic workflow.
    if (isEpub) {
      const existingPlan = await remediationService.getRemediationPlan(stateData.jobId);
      if (!existingPlan) {
        logger.info(`[WorkflowAgent] No remediation plan found for job ${stateData.jobId}, creating one`);
        await remediationService.createRemediationPlan(stateData.jobId);
      }
    } else {
      try {
        await pdfRemediationService.getRemediationPlan(stateData.jobId);
      } catch {
        logger.info(`[WorkflowAgent] No PDF remediation plan found for job ${stateData.jobId}, creating one`);
        await pdfRemediationService.createRemediationPlan(stateData.jobId);
      }
    }

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

        // Emit WebSocket remediation progress event
        if (config.features.enableWebSocket) {
          websocketService.emitRemediationProgress({
            workflowId: workflow.id,
            autoFixed: epubResult.totalIssuesFixed,
            manualPending: epubResult.totalIssuesFailed,
            manualComplete: 0,
            total: epubResult.totalIssuesFixed + epubResult.totalIssuesFailed,
          });
        }
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

        // Emit WebSocket remediation progress event
        if (config.features.enableWebSocket) {
          websocketService.emitRemediationProgress({
            workflowId: workflow.id,
            autoFixed: pdfResult.completedTasks,
            manualPending: pdfResult.failedTasks,
            manualComplete: 0,
            total: pdfResult.completedTasks + pdfResult.failedTasks,
          });
        }
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

    // Check if batch policy auto-approves this gate
    if (await this.shouldAutoApprove(workflow, 'REMEDIATION_REVIEW')) {
      logger.info(`[WorkflowAgent] Auto-approving remediation review for batch workflow ${workflow.id}`);
      await enqueueWorkflowEvent(workflow.id, 'REMEDIATION_APPROVED', { autoApproved: true, batchAutoApproval: true });
      return;
    }

    // Emit WebSocket event to notify frontend
    if (config.features.enableWebSocket) {
      websocketService.emitHITLRequired({
        workflowId: workflow.id,
        gate: 'REMEDIATION_REVIEW',
        itemCount: 0, // TODO: get actual count from workflow data
        deepLink: `/workflow/${workflow.id}/hitl/remediation-review`,
      });
    }
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

    // Fetch current job output before update to avoid TOCTOU race condition
    const currentJob = await prisma.job.findUnique({
      where: { id: stateData.jobId },
      select: { output: true },
    });
    const currentOutput = (currentJob?.output as Record<string, unknown>) ?? {};

    // Update job with verification results
    await prisma.job.update({
      where: { id: stateData.jobId },
      data: {
        output: {
          ...currentOutput,
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
   * Maps accessibility audit issues to WCAG 2.1 criteria for human review.
   */
  private async handleConformanceMapping(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Running conformance mapping for workflow ${workflow.id}`);

    const stateData = workflow.stateData as { jobId?: string };
    if (!stateData.jobId) {
      throw new Error('Job ID not found in workflow state');
    }

    // Load the audit job output to get the issues
    const job = await prisma.job.findUnique({
      where: { id: stateData.jobId },
      select: { output: true },
    });

    if (!job?.output) {
      throw new Error('Audit results not found for conformance mapping');
    }

    const auditData = job.output as Record<string, unknown>;

    // EPUB audits use combinedIssues; PDF audits use issues
    const rawIssues = (
      (auditData.combinedIssues as unknown[]) ??
      (auditData.issues as unknown[]) ??
      []
    ) as Array<Record<string, unknown>>;

    // Normalise to AuditIssueInput
    const auditIssues: AuditIssueInput[] = rawIssues.map((issue, idx) => ({
      id: (issue.id as string) ?? `issue-${idx}`,
      ruleId: (issue.ruleId as string) ?? (issue.code as string) ?? 'unknown',
      impact: (issue.impact as string) ?? (issue.severity as string) ?? 'moderate',
      message: (issue.message as string) ?? (issue.description as string) ?? '',
      filePath: (issue.filePath as string) ?? (issue.location as string) ?? '',
      htmlSnippet: (issue.htmlSnippet as string) ?? null,
      xpath: (issue.xpath as string) ?? null,
    }));

    logger.info(`[WorkflowAgent] Mapping ${auditIssues.length} issues to WCAG criteria`);

    // Generate per-criterion conformance using the ACR confidence engine
    const criteriaResults = await acrGeneratorService.generateConfidenceAnalysis(
      'VPAT2.5-INT',
      auditIssues
    );

    // Map to the shape the ConformanceReviewPage expects
    const statusToAiConformance = (
      status: string
    ): 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable' => {
      if (status === 'pass') return 'supports';
      if (status === 'fail') return 'does_not_support';
      if (status === 'needs_review') return 'partially_supports';
      return 'not_applicable';
    };

    const conformanceMappings = criteriaResults.map(c => ({
      criterionId: c.criterionId,
      title: c.name,
      level: c.level,
      aiConformance: statusToAiConformance(c.status),
      confidence: c.confidenceScore / 100, // store as 0-1
      reasoning: c.remarks,
      issueCount: c.issueCount ?? 0,
    }));

    // Persist mappings in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          conformanceMappings,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    logger.info(`[WorkflowAgent] Conformance mapping completed: ${conformanceMappings.length} criteria`);
    await enqueueWorkflowEvent(workflow.id, 'CONFORMANCE_DONE');
  }

  /**
   * Handle AWAITING_CONFORMANCE_REVIEW state (HITL gate).
   * This is a Human-in-the-Loop gate - no automated action.
   */
  private async handleAwaitingConformanceReview(workflow: WorkflowInstance): Promise<void> {
    logger.info(`[WorkflowAgent] Workflow ${workflow.id} awaiting conformance review (HITL gate)`);

    // Check if batch policy auto-approves this gate
    if (await this.shouldAutoApprove(workflow, 'CONFORMANCE_REVIEW')) {
      logger.info(`[WorkflowAgent] Auto-approving conformance review for batch workflow ${workflow.id}`);
      await enqueueWorkflowEvent(workflow.id, 'CONFORMANCE_APPROVED', { autoApproved: true, batchAutoApproval: true });
      return;
    }

    // Emit WebSocket event to notify frontend
    if (config.features.enableWebSocket) {
      websocketService.emitHITLRequired({
        workflowId: workflow.id,
        gate: 'CONFORMANCE_REVIEW',
        itemCount: 0, // TODO: get actual count from workflow data
        deepLink: `/workflow/${workflow.id}/hitl/conformance-review`,
      });
    }
  }

  /**
   * Handle ACR_GENERATION state.
   * Generates Accessibility Conformance Report (ACR/VPAT) using AI analysis and conformance results.
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

    // Get job ID from workflow state
    const stateData = workflow.stateData as { jobId?: string };
    const jobId = stateData.jobId;

    if (!jobId) {
      logger.warn(`[WorkflowAgent] No job ID in workflow state, skipping ACR generation`);
      await enqueueWorkflowEvent(workflow.id, 'ACR_DONE');
      return;
    }

    // Resolve edition and ACR metadata from batch config, or fall back to defaults
    let edition = 'international';
    let vendor: string | undefined;
    let contactEmail: string | undefined;

    if (workflow.batchId) {
      const batch = await prisma.batchWorkflow.findUnique({ where: { id: workflow.batchId } });
      const stored = batch?.autoApprovalPolicy as Record<string, unknown> | null;
      const acrConfig = stored?.acrConfig as { vendor?: string; contactEmail?: string; edition?: string } | undefined;
      if (acrConfig?.edition) {
        const EDITION_MAP: Record<string, string> = {
          'VPAT2.5-WCAG': 'wcag',
          'VPAT2.5-508':  '508',
          'VPAT2.5-EU':   'eu',
          'VPAT2.5-INT':  'international',
        };
        edition = EDITION_MAP[acrConfig.edition] ?? 'international';
      }
      if (acrConfig?.vendor) vendor = acrConfig.vendor;
      if (acrConfig?.contactEmail) contactEmail = acrConfig.contactEmail;
    }

    const documentTitle = file.originalName ?? file.filename;

    logger.info(`[WorkflowAgent] Creating ACR with AI analysis results: edition=${edition}, jobId=${jobId}`);

    // Get job with validation results to analyze confidence
    const jobWithValidation = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        validationResults: {
          include: {
            issues: true
          }
        }
      }
    });

    if (!jobWithValidation) {
      throw new Error(`Job ${jobId} not found for ACR generation`);
    }

    // Import services needed for ACR generation
    const { confidenceAnalyzerService } = await import('../acr/confidence-analyzer.service');

    // Build validation results for confidence analysis (same logic as confidence.controller.ts)
    const criteriaMap = new Map<string, { criterionId: string; wcagCriterion: string; status: string }>();

    for (const result of jobWithValidation.validationResults || []) {
      const details = result.details as Record<string, unknown> | null;

      if (details && typeof details === 'object') {
        const criteriaFromDetails = details.criteriaChecked as string[] | undefined;
        if (criteriaFromDetails && Array.isArray(criteriaFromDetails)) {
          for (const criterionId of criteriaFromDetails) {
            if (!criteriaMap.has(criterionId)) {
              criteriaMap.set(criterionId, {
                criterionId,
                wcagCriterion: criterionId,
                status: result.passed ? 'pass' : 'fail'
              });
            }
          }
        }
      }

      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) {
          if (issue.wcagCriteria) {
            criteriaMap.set(issue.wcagCriteria, {
              criterionId: issue.wcagCriteria,
              wcagCriterion: issue.wcagCriteria,
              status: 'fail'
            });
          }
        }
      }
    }

    // ALWAYS analyze ALL 50 WCAG 2.1 Level A & AA criteria (same as manual workflow)
    // Get default summary which includes all criteria, then enhance with validation results
    const allCriteriaSummary = confidenceAnalyzerService.getDefaultCriteriaSummary();

    logger.info(`[WorkflowAgent] Analyzing all ${allCriteriaSummary.items.length} WCAG 2.1 criteria`);

    // Build verification data matching manual workflow approach
    const verificationData = allCriteriaSummary.items.map(criterion => {
      // Check if we have validation data for this criterion
      const validationData = criteriaMap.get(criterion.criterionId);

      let verificationStatus: string;
      let confidence: number;
      let verificationMethod: string;
      let verificationNotes: string | undefined;

      // Priority 1: Actual validation results (EPUBCheck + ACE)
      if (validationData && validationData.status === 'pass') {
        // Validation passed - high confidence
        verificationStatus = 'verified_pass';
        confidence = 95;
        verificationMethod = 'Automated Validation';
        verificationNotes = 'Passed automated accessibility checks';
      } else if (validationData && validationData.status === 'fail') {
        // Validation failed - low confidence, needs review
        verificationStatus = 'needs_review';
        confidence = 20;
        verificationMethod = 'Automated Validation';
        verificationNotes = 'Issues detected - requires manual review';
      }
      // Priority 2: Confidence analyzer assessment (same as manual workflow)
      else if (criterion.confidenceLevel === 'HIGH') {
        // High-confidence auto-verifiable criteria
        verificationStatus = 'verified_pass';
        confidence = criterion.confidencePercentage; // already 0-100 scale
        verificationMethod = 'AI Analysis';
        verificationNotes = criterion.reason || 'Automated analysis indicates compliance';
      } else if (criterion.confidenceLevel === 'MEDIUM') {
        // Medium-confidence criteria
        verificationStatus = 'needs_review';
        confidence = criterion.confidencePercentage; // already 0-100 scale
        verificationMethod = 'AI Analysis';
        verificationNotes = criterion.reason || 'Requires verification';
      } else if (criterion.confidenceLevel === 'LOW') {
        // Low-confidence criteria
        verificationStatus = 'needs_review';
        confidence = criterion.confidencePercentage; // already 0-100 scale
        verificationMethod = 'AI Analysis';
        verificationNotes = criterion.reason || 'Limited automation - manual review recommended';
      } else {
        // Manual review required
        verificationStatus = 'needs_review';
        confidence = 0;
        verificationMethod = 'Manual Review';
        verificationNotes = criterion.reason || 'Manual verification required';
      }

      return {
        criterionId: criterion.criterionId,
        verificationStatus,
        verificationMethod,
        verificationNotes,
        isNotApplicable: false,
        naReason: undefined,
        naSuggestion: undefined,
        confidence,
      };
    });

    // Count by confidence levels (matching manual workflow stats)
    const highConfidenceCount = verificationData.filter(v => v.confidence >= 90).length;
    const mediumConfidenceCount = verificationData.filter(v => v.confidence >= 70 && v.confidence < 90).length;
    const lowConfidenceCount = verificationData.filter(v => v.confidence < 70 && v.confidence > 0).length;
    const manualReviewCount = verificationData.filter(v => v.confidence === 0).length;

    logger.info(`[WorkflowAgent] Built verification data: ${verificationData.length} total criteria`);
    logger.info(`[WorkflowAgent] Confidence distribution: ${highConfidenceCount} high (≥90%), ${mediumConfidenceCount} medium (70-89%), ${lowConfidenceCount} low (<70%), ${manualReviewCount} manual review (0%)`);

    // Debug: Log sample of each category
    if (highConfidenceCount > 0) {
      const sample = verificationData.filter(v => v.confidence >= 90).slice(0, 3).map(v => `${v.criterionId}: ${v.confidence}%`).join(', ');
      logger.info(`[WorkflowAgent] High confidence sample: ${sample}`);
    }
    if (mediumConfidenceCount > 0) {
      const sample = verificationData.filter(v => v.confidence >= 70 && v.confidence < 90).slice(0, 3).map(v => `${v.criterionId}: ${v.confidence}%`).join(', ');
      logger.info(`[WorkflowAgent] Medium confidence sample: ${sample}`);
    }
    if (lowConfidenceCount > 0) {
      const sample = verificationData.filter(v => v.confidence < 70 && v.confidence > 0).slice(0, 3).map(v => `${v.criterionId}: ${v.confidence}%`).join(', ');
      logger.info(`[WorkflowAgent] Low confidence sample: ${sample}`);
    }

    // Create ACR using verification data (same as manual workflow)
    const { acrReportReviewService } = await import('../acr/acr-report-review.service');
    const acrResult = await acrReportReviewService.initializeReportFromVerification(
      jobId,
      file.tenantId,
      workflow.createdBy,
      edition,
      verificationData,
      documentTitle
    );

    if (!acrResult || !acrResult.acrJobId) {
      throw new Error('Failed to generate ACR: initializeReportFromVerification returned invalid result');
    }

    logger.info(`[WorkflowAgent] ACR generated with verification data: acrJobId=${acrResult.acrJobId}, imported=${acrResult.imported}`);

    // Store ACR reference and metadata in workflow state
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          acrJobId: acrResult.acrJobId,
          acrEdition: edition,
          acrCriteriaCount: acrResult.totalCriteria,
          acrGeneratedAt: new Date().toISOString(),
          jobId: jobId,
          ...(vendor ? { acrVendor: vendor } : {}),
          ...(contactEmail ? { acrContactEmail: contactEmail } : {}),
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

    // Check if batch policy auto-approves this gate
    if (await this.shouldAutoApprove(workflow, 'ACR_SIGNOFF')) {
      logger.info(`[WorkflowAgent] Auto-approving ACR signoff for batch workflow ${workflow.id}`);
      await enqueueWorkflowEvent(workflow.id, 'ACR_SIGNED', { autoApproved: true, batchAutoApproval: true });
      return;
    }

    // Emit WebSocket event to notify frontend
    if (config.features.enableWebSocket) {
      websocketService.emitHITLRequired({
        workflowId: workflow.id,
        gate: 'ACR_SIGNOFF',
        itemCount: 1, // Single ACR document to sign off
        deepLink: `/workflow/${workflow.id}/hitl/acr-signoff`,
      });
    }
  }

  /**
   * Check whether the batch auto-approval policy permits skipping a specific HITL gate.
   *
   * Supports Phase 1 (string) and Phase 2 (ConditionalGatePolicy object) formats:
   *  - 'auto-accept'                    → always approve
   *  - 'require-manual'                 → never approve
   *  - { mode: 'auto-accept' }          → always approve
   *  - { mode: 'require-manual' }       → never approve
   *  - { mode: 'conditional', conditions } → evaluate conditions
   *
   * @param workflow - Current workflow instance (must have batchId set).
   * @param gate     - The HITL gate key to check.
   * @returns True if the gate should be auto-approved.
   */
  private async shouldAutoApprove(
    workflow: WorkflowInstance,
    gate: keyof BatchAutoApprovalPolicy['gates']
  ): Promise<boolean> {
    if (!workflow.batchId) return false;

    const batch = await prisma.batchWorkflow.findUnique({
      where: { id: workflow.batchId },
      select: { autoApprovalPolicy: true },
    });

    if (!batch?.autoApprovalPolicy) return false;

    const policy = batch.autoApprovalPolicy as unknown as BatchAutoApprovalPolicy;
    const gatePolicy = policy.gates[gate];

    if (!gatePolicy) return false;

    // Phase 1: simple string
    if (typeof gatePolicy === 'string') {
      return gatePolicy === 'auto-accept';
    }

    // Phase 2: ConditionalGatePolicy object
    const conditional = gatePolicy as ConditionalGatePolicy;

    if (conditional.mode === 'auto-accept') return true;
    if (conditional.mode === 'require-manual') return false;

    if (conditional.mode === 'conditional') {
      return this.evaluateConditions(workflow, gate, conditional.conditions ?? {});
    }

    return false;
  }

  /**
   * Evaluate Phase 2 conditional policy conditions for a HITL gate.
   *
   * Conditions supported:
   *  - minConfidence: auditScore / 100 must be >= threshold
   *  - issueTypeRules: ALL issues in the workflow must be covered by a
   *    non-'manual' rule; if any issue has no rule or rule === 'manual',
   *    returns false (requires human review).
   *
   * When issueTypeRules passes, auto-decisions are written to workflow stateData.
   */
  private async evaluateConditions(
    workflow: WorkflowInstance,
    gate: keyof BatchAutoApprovalPolicy['gates'],
    conditions: PolicyConditions
  ): Promise<boolean> {
    const stateData = workflow.stateData as Record<string, unknown>;

    // --- minConfidence check ---
    if (conditions.minConfidence !== undefined) {
      // auditScore is stored as 0–100; convert to 0–1 for comparison
      const rawScore = stateData.auditScore as number | undefined;
      if (rawScore === undefined) {
        logger.info(
          `[WorkflowAgent] minConfidence check skipped for ${workflow.id}: no auditScore in stateData`
        );
        return false;
      }
      const score = rawScore / 100;
      if (score < conditions.minConfidence) {
        logger.info(
          `[WorkflowAgent] Workflow ${workflow.id} confidence ${score.toFixed(2)} < ` +
          `threshold ${conditions.minConfidence} at gate ${gate} — requiring manual review`
        );
        return false;
      }
      logger.info(
        `[WorkflowAgent] Workflow ${workflow.id} confidence ${score.toFixed(2)} >= ` +
        `threshold ${conditions.minConfidence} at gate ${gate}`
      );
    }

    // --- issueTypeRules check (AI_REVIEW gate only) ---
    if (conditions.issueTypeRules && gate === 'AI_REVIEW') {
      const jobId = stateData.jobId as string | undefined;
      if (!jobId) {
        logger.info(`[WorkflowAgent] issueTypeRules check skipped for ${workflow.id}: no jobId`);
        return false;
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { output: true },
      });

      const output = job?.output as Record<string, unknown> | null;
      const rawIssues = (
        (output?.combinedIssues as unknown[]) ??
        (output?.issues as unknown[]) ??
        []
      ) as Array<Record<string, unknown>>;

      if (rawIssues.length === 0) {
        // No issues — nothing to block auto-approval
        logger.info(`[WorkflowAgent] No issues found for workflow ${workflow.id} — auto-approving`);
        return true;
      }

      // Check whether every issue can be auto-handled
      const unhandled = rawIssues.filter(issue => {
        const code = (issue.ruleId ?? issue.code ?? issue.id ?? '') as string;
        const category = categorizeIssue(code);
        const rule = conditions.issueTypeRules![category] ?? conditions.issueTypeRules!['other'];
        return !rule || rule === 'manual';
      });

      if (unhandled.length > 0) {
        logger.info(
          `[WorkflowAgent] Workflow ${workflow.id} has ${unhandled.length} issue(s) ` +
          `requiring manual review based on issueTypeRules at gate ${gate}`
        );
        return false;
      }

      // All issues are covered — write auto-decisions to workflow state
      await this.applyIssueTypeDecisions(workflow, rawIssues, conditions.issueTypeRules);
    }

    return true;
  }

  /**
   * Persist auto-decisions derived from issueTypeRules into workflow stateData.
   * Decisions are stored as `aiReviewDecisions` so downstream steps can read them
   * the same way as manually submitted decisions.
   */
  private async applyIssueTypeDecisions(
    workflow: WorkflowInstance,
    issues: Array<Record<string, unknown>>,
    rules: Record<string, 'auto-accept' | 'auto-reject' | 'manual'>
  ): Promise<void> {
    const decisions = issues.map(issue => {
      const code = (issue.ruleId ?? issue.code ?? issue.id ?? '') as string;
      const category = categorizeIssue(code);
      const rule = rules[category] ?? rules['other'] ?? 'manual';
      return {
        itemId: (issue.id as string) ?? code,
        decision: rule === 'auto-accept' ? 'ACCEPT' : 'REJECT',
        modifiedValue: null,
        justification: `Batch policy auto-${rule} for category: ${category}`,
      };
    });

    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(workflow.stateData as Record<string, unknown>),
          aiReviewDecisions: decisions,
          aiReviewDecisionsSource: 'batch-policy-issue-type-rules',
          aiReviewDecisionsAppliedAt: new Date().toISOString(),
        } as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    logger.info(
      `[WorkflowAgent] Applied ${decisions.length} issue-type-rule decisions ` +
      `to workflow ${workflow.id}`
    );
  }

  /**
   * Handle a workflow error according to the batch's configured error strategy.
   * Called from the main error handler when the workflow belongs to a batch.
   *
   * Strategies:
   *  - 'pause-batch'     — pause all RUNNING/AWAITING siblings.
   *  - 'continue-others' — do nothing; siblings keep processing independently.
   *  - 'fail-batch'      — cancel all non-terminal siblings immediately.
   */
  private async handleBatchWorkflowError(
    workflow: WorkflowInstance,
    error: unknown
  ): Promise<void> {
    if (!workflow.batchId) return;

    const batch = await prisma.batchWorkflow.findUnique({
      where: { id: workflow.batchId },
      select: { autoApprovalPolicy: true, status: true },
    });

    if (!batch?.autoApprovalPolicy) return;

    const policy = batch.autoApprovalPolicy as unknown as BatchAutoApprovalPolicy;
    const strategy = policy.onError;

    logger.info(
      `[WorkflowAgent] Batch error strategy '${strategy}' triggered for batch ${workflow.batchId}` +
      ` after workflow ${workflow.id} failed`,
      { error: error instanceof Error ? error.message : String(error) }
    );

    const NON_TERMINAL_STATES = [
      'UPLOAD_RECEIVED', 'PREPROCESSING', 'RUNNING_EPUBCHECK', 'RUNNING_ACE',
      'RUNNING_AI_ANALYSIS', 'AWAITING_AI_REVIEW', 'AUTO_REMEDIATION',
      'AWAITING_REMEDIATION_REVIEW', 'VERIFICATION_AUDIT', 'CONFORMANCE_MAPPING',
      'AWAITING_CONFORMANCE_REVIEW', 'ACR_GENERATION', 'AWAITING_ACR_SIGNOFF',
      'RETRYING',
    ];

    if (strategy === 'pause-batch') {
      // Pause all non-terminal siblings
      const siblings = await prisma.workflowInstance.findMany({
        where: {
          batchId: workflow.batchId,
          id: { not: workflow.id },
          currentState: { in: NON_TERMINAL_STATES },
        },
        select: { id: true },
      });

      await Promise.all(
        siblings.map(s => enqueueWorkflowEvent(s.id, 'PAUSE').catch(err =>
          logger.error(`[WorkflowAgent] Failed to pause sibling ${s.id}:`, err)
        ))
      );

      await prisma.batchWorkflow.update({
        where: { id: workflow.batchId },
        data: { status: 'PAUSED' },
      });

      logger.info(
        `[WorkflowAgent] Paused ${siblings.length} sibling workflows and set batch status to PAUSED`
      );

    } else if (strategy === 'fail-batch') {
      // Cancel all non-terminal siblings
      const siblings = await prisma.workflowInstance.findMany({
        where: {
          batchId: workflow.batchId,
          id: { not: workflow.id },
          currentState: { in: NON_TERMINAL_STATES },
        },
        select: { id: true },
      });

      await Promise.all(
        siblings.map(s => enqueueWorkflowEvent(s.id, 'CANCEL').catch(err =>
          logger.error(`[WorkflowAgent] Failed to cancel sibling ${s.id}:`, err)
        ))
      );

      await prisma.batchWorkflow.update({
        where: { id: workflow.batchId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });

      logger.info(
        `[WorkflowAgent] Cancelled ${siblings.length} sibling workflows and set batch status to CANCELLED`
      );

    } else {
      // 'continue-others' — do nothing, siblings continue independently
      logger.info(
        `[WorkflowAgent] Batch error strategy 'continue-others': siblings continue processing`
      );
    }
  }
}

// Export singleton instance
export const workflowAgentService = new WorkflowAgentService();
