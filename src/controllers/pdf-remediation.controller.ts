/**
 * PDF Remediation Controller
 *
 * Handles HTTP requests for PDF remediation workflow
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';
import { pdfRemediationService } from '../services/pdf/pdf-remediation.service';
import { pdfAutoRemediationService } from '../services/pdf/pdf-auto-remediation.service';
import { fileStorageService } from '../services/storage/file-storage.service';

export class PdfRemediationController {
  /**
   * Create a remediation plan from audit results
   * POST /api/v1/pdf/:jobId/remediation/plan
   *
   * @param req - Authenticated request with jobId param
   * @param res - Express response
   */
  async createPlan(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
          },
        });
      }

      // Verify job is a PDF audit job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility audit',
          },
        });
      }

      // Create remediation plan
      const plan = await pdfRemediationService.createRemediationPlan(jobId);

      return res.status(201).json({
        success: true,
        data: plan,
      });
    } catch (error) {
      logger.error('Failed to create remediation plan', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create remediation plan',
        },
      });
    }
  }

  /**
   * Get existing remediation plan
   * GET /api/v1/pdf/:jobId/remediation/plan
   *
   * @param req - Authenticated request with jobId param
   * @param res - Express response
   */
  async getPlan(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
          },
        });
      }

      // Retrieve remediation plan
      const plan = await pdfRemediationService.getRemediationPlan(jobId);

      return res.status(200).json({
        success: true,
        data: plan,
      });
    } catch (error) {
      logger.error('Failed to retrieve remediation plan', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve remediation plan',
        },
      });
    }
  }

  /**
   * Update task status
   * PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId
   *
   * @param req - Authenticated request with jobId and taskId params
   * @param res - Express response
   */
  async updateTaskStatus(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId, taskId } = req.params;
      const { status, errorMessage, notes } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
          },
        });
      }

      // Update task status
      const result = await pdfRemediationService.updateTaskStatus(
        jobId,
        taskId,
        { status, errorMessage, notes }
      );

      logger.info('Task status updated successfully', {
        jobId,
        taskId,
        status,
        completionPercentage: result.summary.completionPercentage,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Failed to update task status', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
        taskId: req.params.taskId,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update task status',
        },
      });
    }
  }

  /**
   * Execute auto-remediation for a job
   * POST /api/v1/pdf/:jobId/remediation/execute
   *
   * @param req - Authenticated request with jobId param
   * @param res - Express response
   */
  async executeAutoRemediation(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
          },
        });
      }

      // Verify job is a PDF audit job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility audit',
          },
        });
      }

      // Get original PDF from storage
      const jobInput = job.input as { fileName?: string; fileUrl?: string; size?: number };
      const fileName = jobInput?.fileName || 'document.pdf';

      // Try to get file from storage using jobId (primary method)
      logger.info(`[PDF Remediation] Loading PDF for job ${jobId}, fileName: ${fileName}`);
      let pdfBuffer: Buffer | null = null;

      try {
        // Files are stored by jobId, not URL
        pdfBuffer = await fileStorageService.getFile(jobId, fileName);
      } catch (storageError) {
        logger.error(`[PDF Remediation] Error loading from storage:`, storageError);
      }

      // Fallback: try fileUrl if getFile returned null or failed
      if (!pdfBuffer) {
        const fileUrl = jobInput?.fileUrl;
        if (fileUrl) {
          logger.info(`[PDF Remediation] Fallback: Downloading from ${fileUrl}`);
          try {
            pdfBuffer = await fileStorageService.downloadFile(fileUrl);
          } catch (downloadError) {
            logger.error(`[PDF Remediation] Download failed:`, downloadError);
          }
        }
      }

      // If we still don't have a buffer, return error
      if (!pdfBuffer) {
        logger.error(`[PDF Remediation] Could not find file for job ${jobId}`);
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_FILE',
            message: 'Original PDF file not found in storage',
          },
        });
      }

      // Execute auto-remediation
      const result = await pdfAutoRemediationService.runAutoRemediation(
        pdfBuffer,
        jobId,
        fileName
      );

      // If successful and we have a remediated PDF, save it to storage
      if (result.success && result.remediatedPdfBuffer) {
        const remediatedFileName = fileName.replace('.pdf', '_remediated.pdf');
        const remediatedFileUrl = await fileStorageService.saveRemediatedFile(
          jobId,
          remediatedFileName,
          result.remediatedPdfBuffer
        );

        logger.info(`[PDF Remediation] Saved remediated PDF to ${remediatedFileUrl}`);

        // Sanitize result by removing Buffer and converting to plain JSON
        const { remediatedPdfBuffer, ...sanitizedResult } = result;

        // Convert to plain JSON to ensure compatibility with Prisma Json type
        const remediationResultJson = JSON.parse(JSON.stringify(sanitizedResult));

        // Update job output with remediated file URL
        await prisma.job.update({
          where: { id: jobId },
          data: {
            output: {
              ...(job.output as Record<string, unknown>),
              remediatedFileUrl,
              remediationResult: remediationResultJson,
            },
            updatedAt: new Date(),
          },
        });

        return res.status(200).json({
          success: true,
          data: {
            ...result,
            remediatedFileUrl,
          },
        });
      }

      return res.status(200).json({
        success: result.success,
        data: result,
      });
    } catch (error) {
      logger.error('Failed to execute auto-remediation', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to execute auto-remediation',
        },
      });
    }
  }
}

// Export singleton instance
export const pdfRemediationController = new PdfRemediationController();
