/**
 * PDF Verification Service
 *
 * Handles re-audit verification after remediation to confirm fixes were successful
 */

import { nanoid } from 'nanoid';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { JobStatus, PrismaClient } from '@prisma/client';
import { pdfRemediationService } from './pdf-remediation.service';
import type { RemediationTask } from '../../types/pdf-remediation.types';

/**
 * Verification result for a remediation task
 */
export interface TaskVerificationResult {
  taskId: string;
  issueCode: string;
  wasFixed: boolean;
  stillPresent: boolean;
  verificationMethod: 'metadata' | 're-audit' | 'manual';
  notes?: string;
}

/**
 * Overall verification result
 */
export interface VerificationResult {
  jobId: string;
  totalTasks: number;
  verifiedFixed: number;
  stillBroken: number;
  unverified: number;
  taskResults: TaskVerificationResult[];
  reAuditJobId?: string;
}

/**
 * PDF Verification Service
 */
class PdfVerificationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Verify remediation by re-auditing the PDF
   *
   * @param remediatedPdfBuffer - Remediated PDF buffer
   * @param jobId - Original job ID
   * @param fileName - File name
   * @returns Verification result
   */
  async verifyRemediation(
    remediatedPdfBuffer: Buffer,
    jobId: string,
    fileName: string
  ): Promise<VerificationResult> {
    logger.info(`[PDF Verification] Starting verification for job ${jobId}`);

    const result: VerificationResult = {
      jobId,
      totalTasks: 0,
      verifiedFixed: 0,
      stillBroken: 0,
      unverified: 0,
      taskResults: [],
    };

    try {
      // 1. Get the remediation plan
      const plan = await pdfRemediationService.getRemediationPlan(jobId);

      if (!plan) {
        throw new Error(`Remediation plan not found for job ${jobId}`);
      }

      // 2. Filter completed tasks that need verification
      const completedTasks = plan.tasks.filter(
        (task) => task.status === 'COMPLETED' && task.type === 'AUTO_FIXABLE'
      );

      result.totalTasks = completedTasks.length;

      if (completedTasks.length === 0) {
        logger.warn(`[PDF Verification] No completed auto-fixable tasks to verify for job ${jobId}`);
        return result;
      }

      logger.info(`[PDF Verification] Verifying ${completedTasks.length} completed tasks`);

      // 3. For now, use simple metadata verification for Tier-1 handlers
      // TODO: Add full re-audit support when needed
      for (const task of completedTasks) {
        const taskResult = await this.verifyTask(
          remediatedPdfBuffer,
          task,
          fileName
        );

        result.taskResults.push(taskResult);

        if (taskResult.wasFixed) {
          result.verifiedFixed++;
        } else if (taskResult.stillPresent) {
          result.stillBroken++;
        } else {
          result.unverified++;
        }

        // Update task status based on verification
        if (taskResult.wasFixed) {
          logger.info(`[PDF Verification] ✓ Task ${task.id} verified as fixed`);
          // Task remains COMPLETED
        } else if (taskResult.stillPresent) {
          logger.warn(`[PDF Verification] ✗ Task ${task.id} still broken, marking as FAILED`);

          await pdfRemediationService.updateTaskStatus(jobId, task.id, {
            status: 'FAILED',
            errorMessage: 'Verification failed - issue still present after remediation',
            notes: taskResult.notes,
          });
        }
      }

      logger.info(`[PDF Verification] Completed verification for job ${jobId}`, {
        total: result.totalTasks,
        fixed: result.verifiedFixed,
        broken: result.stillBroken,
        unverified: result.unverified,
      });
    } catch (error) {
      logger.error('[PDF Verification] Verification failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId,
      });
      throw error;
    }

    return result;
  }

  /**
   * Verify a single task
   *
   * @param pdfBuffer - Remediated PDF buffer
   * @param task - Remediation task
   * @param fileName - File name
   * @returns Task verification result
   */
  private async verifyTask(
    pdfBuffer: Buffer,
    task: RemediationTask,
    _fileName: string
  ): Promise<TaskVerificationResult> {
    logger.debug(`[PDF Verification] Verifying task ${task.id}: ${task.issueCode}`);

    const result: TaskVerificationResult = {
      taskId: task.id,
      issueCode: task.issueCode,
      wasFixed: false,
      stillPresent: false,
      verificationMethod: 'metadata',
    };

    try {
      // Verify based on issue code
      switch (task.issueCode) {
        case 'PDF-NO-LANGUAGE':
          result.wasFixed = await this.verifyLanguageFixed(pdfBuffer);
          result.stillPresent = !result.wasFixed;
          break;

        case 'PDF-NO-TITLE':
          result.wasFixed = await this.verifyTitleFixed(pdfBuffer);
          result.stillPresent = !result.wasFixed;
          break;

        case 'PDF-NO-METADATA':
          result.wasFixed = await this.verifyMetadataFixed(pdfBuffer);
          result.stillPresent = !result.wasFixed;
          break;

        case 'PDF-NO-CREATOR':
          result.wasFixed = await this.verifyCreatorFixed(pdfBuffer);
          result.stillPresent = !result.wasFixed;
          break;

        default:
          // For other issue types, we can't verify without full re-audit
          result.verificationMethod = 'manual';
          result.notes = 'Manual verification required';
          logger.warn(`[PDF Verification] No verification method for ${task.issueCode}`);
      }
    } catch (error) {
      logger.error(`[PDF Verification] Failed to verify task ${task.id}`, { error });
      result.notes = `Verification error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    return result;
  }

  /**
   * Verify language was added
   */
  private async verifyLanguageFixed(pdfBuffer: Buffer): Promise<boolean> {
    try {
      // Write to temp file for parsing
      const tempPath = await this.writeTempFile(pdfBuffer);

      try {
        const { PDFDocument } = await import('pdf-lib');
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const catalog = pdfDoc.catalog;
        const langEntry = catalog.lookup(catalog.context.obj('Lang'));

        const hasLanguage = langEntry !== undefined && langEntry !== null;

        logger.debug(`[PDF Verification] Language check: ${hasLanguage ? 'PASS' : 'FAIL'}`);
        return hasLanguage;
      } finally {
        await this.cleanupTempFile(tempPath);
      }
    } catch (error) {
      logger.error('[PDF Verification] Language verification failed', { error });
      return false;
    }
  }

  /**
   * Verify title was added
   */
  private async verifyTitleFixed(pdfBuffer: Buffer): Promise<boolean> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const title = pdfDoc.getTitle();

      const hasTitle = title !== undefined && title !== null && title.length > 0;

      logger.debug(`[PDF Verification] Title check: ${hasTitle ? 'PASS' : 'FAIL'}`);
      return hasTitle;
    } catch (error) {
      logger.error('[PDF Verification] Title verification failed', { error });
      return false;
    }
  }

  /**
   * Verify metadata was added
   */
  private async verifyMetadataFixed(pdfBuffer: Buffer): Promise<boolean> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Check if basic metadata fields are present
      const hasTitle = !!pdfDoc.getTitle();
      const hasAuthor = !!pdfDoc.getAuthor();
      const hasSubject = !!pdfDoc.getSubject();

      const hasMetadata = hasTitle || hasAuthor || hasSubject;

      logger.debug(`[PDF Verification] Metadata check: ${hasMetadata ? 'PASS' : 'FAIL'}`);
      return hasMetadata;
    } catch (error) {
      logger.error('[PDF Verification] Metadata verification failed', { error });
      return false;
    }
  }

  /**
   * Verify creator was added
   */
  private async verifyCreatorFixed(pdfBuffer: Buffer): Promise<boolean> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const creator = pdfDoc.getCreator();

      const hasCreator = creator !== undefined && creator !== null && creator.length > 0;

      logger.debug(`[PDF Verification] Creator check: ${hasCreator ? 'PASS' : 'FAIL'}`);
      return hasCreator;
    } catch (error) {
      logger.error('[PDF Verification] Creator verification failed', { error });
      return false;
    }
  }

  /**
   * Write PDF buffer to temporary file
   */
  private async writeTempFile(buffer: Buffer): Promise<string> {
    const tempDir = os.tmpdir();
    const tempPath = path.join(tempDir, `pdf-verify-${nanoid()}.pdf`);
    await fs.writeFile(tempPath, buffer);
    return tempPath;
  }

  /**
   * Clean up temporary file
   */
  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      logger.warn(`[PDF Verification] Failed to cleanup temp file ${filePath}`, { error });
    }
  }

  /**
   * Trigger full re-audit (for future use)
   *
   * @param remediatedPdfBuffer - Remediated PDF buffer
   * @param originalJobId - Original job ID
   * @param fileName - File name
   * @returns Re-audit job ID
   */
  async triggerReAudit(
    remediatedPdfBuffer: Buffer,
    originalJobId: string,
    fileName: string
  ): Promise<string> {
    logger.info(`[PDF Verification] Triggering re-audit for job ${originalJobId}`);

    // Get original job details
    const originalJob = await this.prisma.job.findUnique({
      where: { id: originalJobId },
    });

    if (!originalJob) {
      throw new Error(`Original job ${originalJobId} not found`);
    }

    // Create new job for re-audit
    const reAuditJob = await this.prisma.job.create({
      data: {
        id: nanoid(),
        tenantId: originalJob.tenantId,
        userId: originalJob.userId,
        type: 'PDF_ACCESSIBILITY',
        status: JobStatus.QUEUED,
        input: {
          fileName: fileName.replace('.pdf', '_remediated.pdf'),
          originalJobId,
          isReAudit: true,
        },
      },
    });

    logger.info(`[PDF Verification] Created re-audit job ${reAuditJob.id}`);

    // TODO: Queue the re-audit job for processing
    // This would trigger the normal PDF audit workflow

    return reAuditJob.id;
  }
}

// Export singleton instance
export const pdfVerificationService = new PdfVerificationService(prisma);
