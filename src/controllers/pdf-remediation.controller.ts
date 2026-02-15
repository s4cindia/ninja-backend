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
import { pdfModifierService } from '../services/pdf/pdf-modifier.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { pdfReauditService } from '../services/pdf/pdf-reaudit.service';
import { PDFName, PDFDict } from 'pdf-lib';
import path from 'path';

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
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
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
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
        });
      }

      // Verify job is a PDF audit job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility audit',
            details: null,
          },
        });
      }

      // Create remediation plan
      const plan = await pdfRemediationService.createRemediationPlan(jobId);

      return res.status(201).json({
        success: true,
        data: plan,
        error: {
          code: null,
          message: null,
          details: null,
        },
      });
    } catch (error) {
      logger.error('Failed to create remediation plan', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create remediation plan',
          details: null,
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
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
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
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
        });
      }

      // Retrieve remediation plan
      const plan = await pdfRemediationService.getRemediationPlan(jobId);

      return res.status(200).json({
        success: true,
        data: plan,
        error: {
          code: null,
          message: null,
          details: null,
        },
      });
    } catch (error) {
      logger.error('Failed to retrieve remediation plan', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve remediation plan',
          details: null,
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
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
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
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
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
        completionPercentage: result.summary?.completionPercentage ?? 0,
      });

      return res.status(200).json({
        success: true,
        data: result,
        error: {
          code: null,
          message: null,
          details: null,
        },
      });
    } catch (error) {
      logger.error('Failed to update task status', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
        taskId: req.params.taskId,
      });

      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update task status',
          details: null,
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
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
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
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
        });
      }

      // Verify job is a PDF audit job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility audit',
            details: null,
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
          data: {},
          error: {
            code: 'MISSING_FILE',
            message: 'Original PDF file not found in storage',
            details: null,
          },
        });
      }

      // Execute auto-remediation
      const result = await pdfAutoRemediationService.runAutoRemediation(
        pdfBuffer,
        jobId,
        fileName
      );

      // Sanitize result by removing Buffer and converting to plain JSON
      const { remediatedPdfBuffer: _remediatedPdfBuffer, ...sanitizedResult } = result;

      // If successful and we have a remediated PDF, save it to storage
      if (result.success && result.remediatedPdfBuffer) {
        const remediatedFileName = fileName.replace('.pdf', '_remediated.pdf');
        const remediatedFileUrl = await fileStorageService.saveRemediatedFile(
          jobId,
          remediatedFileName,
          result.remediatedPdfBuffer
        );

        logger.info(`[PDF Remediation] Saved remediated PDF to ${remediatedFileUrl}`);

        // Convert to plain JSON to ensure compatibility with Prisma Json type
        const remediationResultJson = JSON.parse(JSON.stringify(sanitizedResult));

        // Update job output with remediated file URL
        await prisma.job.update({
          where: { id: jobId },
          data: {
            output: {
              ...((job.output as Record<string, unknown> | null) ?? {}),
              remediatedFileUrl,
              remediationResult: remediationResultJson,
            },
            updatedAt: new Date(),
          },
        });

        return res.status(200).json({
          success: true,
          data: {
            ...sanitizedResult,
            remediatedFileUrl,
          },
          error: {
            code: null,
            message: null,
            details: null,
          },
        });
      }

      return res.status(200).json({
        success: result.success,
        data: sanitizedResult,
        error: {
          code: null,
          message: null,
          details: null,
        },
      });
    } catch (error) {
      logger.error('Failed to execute auto-remediation', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to execute auto-remediation',
          details: null,
        },
      });
    }
  }

  /**
   * Preview what will change before applying a fix
   * GET /api/v1/pdf/:jobId/remediation/preview/:issueId
   */
  async previewFix(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId, issueId } = req.params;
      const { field, value } = req.query;
      const tenantId = req.user?.tenantId;

      // Validate query parameters
      if (typeof field !== 'string' || !['language', 'title', 'creator', 'metadata'].includes(field)) {
        return res.status(400).json({
          success: false,
          error: { message: 'Invalid or missing field parameter' },
        });
      }

      if (value !== undefined && typeof value !== 'string') {
        return res.status(400).json({
          success: false,
          error: { message: 'Invalid value parameter' },
        });
      }

      // Title field requires a non-empty value
      if (field === 'title' && (typeof value !== 'string' || value.trim() === '')) {
        return res.status(400).json({
          success: false,
          error: { message: 'Title value is required and cannot be empty' },
        });
      }

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { message: 'Authentication required' },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: { message: 'Job not found' },
        });
      }

      // Ensure this is a PDF job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: { message: 'Job is not a PDF accessibility job' },
        });
      }

      // Get current PDF file using same pattern as executeAutoRemediation
      const jobInput = job.input as { fileName?: string; fileUrl?: string; size?: number };
      const fileName = jobInput?.fileName || 'document.pdf';

      // Try to get file from storage using jobId
      logger.info(`[PDF Remediation] Loading PDF for preview, job ${jobId}, fileName: ${fileName}`);
      let pdfBuffer: Buffer | null = null;

      try {
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
          error: { message: 'PDF file not found in storage' },
        });
      }

      // Load PDF and get current value
      const pdfDoc = await pdfModifierService.loadPDF(pdfBuffer);

      let currentValue: string | null = null;
      let proposedValue: string = value || '';

      switch (field) {
        case 'language':
          currentValue = pdfDoc.catalog.get(PDFName.of('Lang'))?.toString() || null;
          proposedValue = proposedValue || 'en-US';
          break;
        case 'title':
          currentValue = pdfDoc.getTitle() || null;
          break;
        case 'creator':
          currentValue = pdfDoc.getCreator() || null;
          proposedValue = proposedValue || 'Ninja Accessibility Tool';
          break;
        case 'metadata': {
          // Read current MarkInfo from catalog
          const markInfo = pdfDoc.catalog.get(PDFName.of('MarkInfo'));
          if (markInfo instanceof PDFDict) {
            const marked = markInfo.get(PDFName.of('Marked'));
            currentValue = marked ? `Marked: ${marked.toString()}` : 'MarkInfo present but Marked not set';
          } else {
            currentValue = 'Not set';
          }
          proposedValue = 'Marked: true';
          break;
        }
        default:
          logger.error(`[PDF Remediation] Unknown field: ${field}`);
          return res.status(400).json({
            success: false,
            error: { message: `Unknown field: ${field}` },
          });
      }

      logger.info(`[PDF Remediation] Previewing ${field} fix for issue ${issueId}`);

      return res.json({
        success: true,
        data: {
          issueId,
          field,
          before: currentValue || '',
          after: proposedValue,
          message: `Will change ${field} from "${currentValue || '(empty)'}" to "${proposedValue}"`,
        },
      });
    } catch (error) {
      logger.error('[PDF Remediation] Preview failed', { error });
      return res.status(500).json({
        success: false,
        error: { message: 'Failed to preview fix' },
      });
    }
  }

  /**
   * Apply a quick fix to a specific issue
   * POST /api/v1/pdf/:jobId/remediation/quick-fix/:issueId
   */
  async applyQuickFix(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId, issueId } = req.params;
      const { field, value } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { message: 'Authentication required' },
        });
      }

      // Verify job exists
      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: { message: 'Job not found' },
        });
      }

      // Ensure this is a PDF job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: { message: 'Job is not a PDF accessibility job' },
        });
      }

      // Get current PDF file using same pattern as executeAutoRemediation
      const jobInput = job.input as { fileName?: string; fileUrl?: string; size?: number };
      const fileName = jobInput?.fileName || 'document.pdf';

      // Check if a remediated file already exists (from previous quick fixes)
      const parsed = path.parse(fileName);
      const remediatedFileName = `${parsed.name}_remediated${parsed.ext || '.pdf'}`;

      logger.info(`[PDF Remediation] Loading PDF for quick-fix, job ${jobId}`);
      let pdfBuffer: Buffer | null = null;
      let sourceFile = fileName;

      // Try remediated file first (if exists from previous quick fixes)
      logger.info(`[PDF Remediation] Attempting to load remediated file: ${remediatedFileName}`);
      try {
        // Use getRemediatedFile which looks in the remediated/ subdirectory
        pdfBuffer = await fileStorageService.getRemediatedFile(jobId, fileName);
        logger.info(`[PDF Remediation] getRemediatedFile result: ${pdfBuffer ? `Buffer(${pdfBuffer.length} bytes)` : 'null'}`);

        if (pdfBuffer) {
          sourceFile = remediatedFileName;
          logger.info(`[PDF Remediation] ✅ Loaded existing remediated file: ${remediatedFileName}`);
        } else {
          logger.info(`[PDF Remediation] ⚠️  No remediated file found for ${fileName}`);
        }
      } catch (remediatedError) {
        logger.info(`[PDF Remediation] ❌ Error loading remediated file: ${remediatedError}`);
      }

      // If no remediated file, try original
      if (!pdfBuffer) {
        logger.info(`[PDF Remediation] Loading original file: ${fileName}`);

        try {
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
      }

      // If we still don't have a buffer, return error
      if (!pdfBuffer) {
        logger.error(`[PDF Remediation] Could not find file for job ${jobId}`);
        return res.status(400).json({
          success: false,
          error: { message: 'PDF file not found in storage' },
        });
      }

      logger.info(`[PDF Remediation] Using file: ${sourceFile}`);

      // Load PDF and apply fix
      const pdfDoc = await pdfModifierService.loadPDF(pdfBuffer);

      let result;
      switch (field) {
        case 'language':
          result = await pdfModifierService.addLanguage(pdfDoc, value || 'en-US');
          break;
        case 'title': {
          const trimmed = value?.toString().trim();
          if (!trimmed || trimmed.length === 0) {
            return res.status(400).json({
              success: false,
              error: { message: 'Title value is required and cannot be empty' },
            });
          }
          result = await pdfModifierService.addTitle(pdfDoc, trimmed);
          break;
        }
        case 'metadata':
          result = await pdfModifierService.addMetadata(pdfDoc);
          break;
        case 'creator': {
          const creatorValue = value || 'Ninja Accessibility Tool';
          result = await pdfModifierService.addCreator(pdfDoc, creatorValue);
          break;
        }
        default:
          return res.status(400).json({
            success: false,
            error: { message: `Unknown field: ${field}` },
          });
      }

      if (!result.success) {
        return res.status(500).json({
          success: false,
          error: { message: result.description },
        });
      }

      // Save modified PDF
      const modifiedBuffer = await pdfModifierService.savePDF(pdfDoc);

      // Save to storage using saveRemediatedFile
      const remediatedFileUrl = await fileStorageService.saveRemediatedFile(
        jobId,
        remediatedFileName,
        modifiedBuffer
      );

      // Get remediation plan and find task by issue ID
      const plan = await pdfRemediationService.getRemediationPlan(jobId);
      const task = plan.tasks.find(t => t.issueId === issueId);

      if (!task) {
        logger.error(`[PDF Remediation] Task not found for issue ${issueId}`);
        return res.status(404).json({
          success: false,
          error: { message: 'Task not found for this issue' },
        });
      }

      // Update task status in remediation plan using task ID (not issue ID)
      await pdfRemediationService.updateTaskStatus(jobId, task.id, {
        status: 'COMPLETED',
        notes: `Quick-fix applied: ${result.description}`,
      });

      // Update parent job output with remediated file URL
      const currentOutput = (job.output as Record<string, unknown>) || {};
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: {
            ...currentOutput,
            remediatedFileUrl,
          },
        },
      });

      logger.info(`[PDF Remediation] Quick-fix applied for issue ${issueId}, task ${task.id}`, { result });

      return res.json({
        success: true,
        data: {
          issueId,
          field,
          modification: result,
          remediatedFileUrl,
          message: 'Fix applied successfully',
        },
      });
    } catch (error) {
      logger.error('[PDF Remediation] Quick-fix failed', { error });
      return res.status(500).json({
        success: false,
        error: { message: 'Failed to apply fix' },
      });
    }
  }

  /**
   * Download remediated PDF file
   * GET /api/v1/pdf/:jobId/remediation/download
   *
   * @param req - Authenticated request with jobId param
   * @param res - Express response
   */
  async downloadRemediatedPdf(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        });
        return;
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found',
          },
        });
        return;
      }

      // Verify job type is PDF_ACCESSIBILITY
      logger.info('[PDF Download] Job type check', { jobId, jobType: job.type });
      if (job.type !== 'PDF_ACCESSIBILITY') {
        logger.warn('[PDF Download] Invalid job type', { jobId, jobType: job.type });
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility job',
          },
        });
        return;
      }

      // Define canonical base directory for security
      // MUST match file-storage.service.ts exactly: EPUB_STORAGE_PATH || '/tmp/epub-storage'
      const baseDir = path.resolve(process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage');
      logger.info('[PDF Download] Base directory resolved', {
        baseDir,
        jobId,
        epubStoragePath: process.env.EPUB_STORAGE_PATH,
        usingDefault: !process.env.EPUB_STORAGE_PATH
      });

      const output = job.output as Record<string, unknown>;
      logger.info('[PDF Download] Job output', {
        jobId,
        hasOutput: !!output,
        hasRemediatedFileUrl: !!(output?.remediatedFileUrl),
        remediatedFileUrl: output?.remediatedFileUrl
      });

      let remediatedFilePath: string;

      // Get remediated file path with path traversal protection
      if (output?.remediatedFileUrl && typeof output.remediatedFileUrl === 'string') {
        const requestedPath = output.remediatedFileUrl;
        const isAbsolute = path.isAbsolute(requestedPath);

        // Resolve and normalize the path
        if (isAbsolute) {
          remediatedFilePath = path.normalize(requestedPath);
        } else {
          remediatedFilePath = path.resolve(baseDir, requestedPath);
        }

        // Use path.relative to check if the file is within baseDir
        // If relative path starts with '..', the file is outside baseDir
        const normalizedBaseDir = path.normalize(baseDir);
        const normalizedFilePath = path.normalize(remediatedFilePath);
        const relative = path.relative(normalizedBaseDir, normalizedFilePath);

        logger.info('[PDF Download] Path validation check', {
          jobId,
          requestedPath,
          isAbsolute,
          normalizedBaseDir,
          normalizedFilePath,
          relativePath: relative,
          pathSep: path.sep,
        });

        // Check if path escapes baseDir
        const isOutsideBaseDir = relative !== '' &&
          (relative.split(path.sep)[0] === '..' || relative.startsWith('..' + path.sep));

        logger.info('[PDF Download] Path containment result', {
          jobId,
          isOutsideBaseDir,
          firstSegment: relative.split(path.sep)[0],
          startsWithDotDot: relative.startsWith('..' + path.sep),
        });

        if (isOutsideBaseDir) {
          logger.warn('[PDF Download] Path traversal attempt detected', {
            jobId,
            requestedPath,
            resolvedPath: normalizedFilePath,
            baseDir: normalizedBaseDir,
            relativePath: relative,
          });
          res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_PATH',
              message: 'Invalid file path',
            },
          });
          return;
        }
      } else {
        // Fallback: construct path from job data
        const input = job.input as { fileName?: string };
        const fileName = input?.fileName || 'document.pdf';
        const remediatedFileName = fileName.replace('.pdf', '_remediated.pdf');
        remediatedFilePath = path.join(
          baseDir,
          jobId,
          'remediated',
          remediatedFileName
        );
      }

      // Check if file exists before attempting to read
      const fs = await import('fs/promises');
      try {
        await fs.stat(remediatedFilePath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.info('Remediated PDF not found', { jobId, path: remediatedFilePath });
          res.status(404).json({
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: 'Remediated PDF not found',
            },
          });
          return;
        }
        throw statError;
      }

      // Read file and send as response
      const fileBuffer = await fs.readFile(remediatedFilePath);

      const input = job.input as { fileName?: string };
      const downloadFileName = (input?.fileName || 'document.pdf').replace('.pdf', '_remediated.pdf');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      res.send(fileBuffer);

      logger.info(`[PDF Remediation] Downloaded remediated PDF for job ${jobId}`);
    } catch (error) {
      logger.error('Failed to download remediated PDF', { error, jobId: req.params.jobId });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to download remediated PDF',
        },
      });
    }
  }

  /**
   * Re-audit a remediated PDF and compare with original results
   * POST /api/v1/pdf/:jobId/remediation/re-audit
   *
   * @param req - Request with uploaded remediated PDF file
   * @param res - Response with comparison results
   */
  async reauditPdf(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
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
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
        });
      }

      // Verify job is a PDF audit job
      if (job.type !== 'PDF_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'INVALID_JOB_TYPE',
            message: 'Job is not a PDF accessibility audit',
            details: null,
          },
        });
      }

      // Verify file was uploaded
      if (!req.file) {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'MISSING_FILE',
            message: 'No file uploaded',
            details: null,
          },
        });
      }

      // Validate PDF magic bytes
      const buffer = req.file.buffer;
      const magicBytes = buffer.slice(0, 5).toString('ascii');

      logger.info(`[Re-Audit] File validation`, {
        fileName: req.file.originalname,
        fileSize: buffer.length,
        mimeType: req.file.mimetype,
        magicBytes,
      });

      if (!magicBytes.startsWith('%PDF-')) {
        logger.error(`[Re-Audit] Invalid PDF magic bytes`, {
          expected: '%PDF-',
          received: magicBytes,
        });

        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'INVALID_PDF',
            message: 'Invalid PDF file: file does not contain PDF magic bytes',
            details: null,
          },
        });
      }

      // Run re-audit and comparison
      logger.info(`[Re-Audit] Starting for job ${jobId}`, {
        fileName: req.file.originalname,
        fileSize: buffer.length,
      });

      const comparisonResult = await pdfReauditService.reauditAndCompare(
        jobId,
        buffer,
        req.file.originalname
      );

      // Update job output with comparison data
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: {
            ...((job.output as Record<string, unknown> | null) ?? {}),
            reauditComparison: JSON.parse(JSON.stringify(comparisonResult)),
            lastReauditAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        },
      });

      logger.info(`[Re-Audit] Completed for job ${jobId}`, {
        resolvedCount: comparisonResult.metrics.resolvedCount,
        remainingCount: comparisonResult.metrics.remainingCount,
        regressionCount: comparisonResult.metrics.regressionCount,
        resolutionRate: comparisonResult.metrics.resolutionRate,
      });

      return res.status(200).json({
        success: true,
        data: comparisonResult,
        error: {
          code: null,
          message: null,
          details: null,
        },
      });
    } catch (error) {
      logger.error('Failed to re-audit PDF', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobId: req.params.jobId,
      });

      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to re-audit PDF',
          details: null,
        },
      });
    }
  }
}

// Export singleton instance
export const pdfRemediationController = new PdfRemediationController();
