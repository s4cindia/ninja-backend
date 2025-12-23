import { Request, Response } from 'express';
import { epubAuditService } from '../services/epub/epub-audit.service';
import { remediationService } from '../services/epub/remediation.service';
import { autoRemediationService } from '../services/epub/auto-remediation.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { epubModifier } from '../services/epub/epub-modifier.service';
import { epubComparisonService } from '../services/epub/epub-comparison.service';
import { batchRemediationService } from '../services/epub/batch-remediation.service';
import { epubExportService } from '../services/epub/epub-export.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    tenantId: string;
    role: string;
  };
}

export const epubController = {
  async auditEPUB(req: Request, res: Response) {
    try {
      const job = req.job;
      const { jobId } = req.params;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      if (job.type !== 'EPUB_ACCESSIBILITY') {
        return res.status(400).json({
          success: false,
          error: 'Job is not an EPUB accessibility audit',
        });
      }

      const input = job.input as { filePath?: string; fileName?: string; buffer?: string };
      if (!input.buffer) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file buffer found in job input',
        });
      }

      const buffer = Buffer.from(input.buffer, 'base64');
      const fileName = input.fileName || 'document.epub';

      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'PROCESSING', startedAt: new Date() },
      });

      const result = await epubAuditService.runAudit(buffer, jobId, fileName);

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('EPUB audit failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'EPUB audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async auditFromBuffer(req: AuthenticatedRequest, res: Response) {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.id;
    let jobId: string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file uploaded',
        });
      }

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EPUB_ACCESSIBILITY',
          status: 'PROCESSING',
          input: {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          startedAt: new Date(),
        },
      });
      jobId = job.id;

      await fileStorageService.saveFile(job.id, req.file.originalname, req.file.buffer);

      const result = await epubAuditService.runAudit(
        req.file.buffer,
        job.id,
        req.file.originalname
      );

      await prisma.job.update({
        where: { id: job.id },
        data: { 
          status: 'COMPLETED',
          completedAt: new Date(),
          output: JSON.parse(JSON.stringify(result)),
        },
      });

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('EPUB audit from buffer failed', error instanceof Error ? error : undefined);
      
      if (jobId) {
        await prisma.job.update({
          where: { id: jobId },
          data: { 
            status: 'FAILED',
            completedAt: new Date(),
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        }).catch(() => {});
      }
      
      return res.status(500).json({
        success: false,
        error: 'EPUB audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  async getAuditResult(req: Request, res: Response) {
    try {
      const job = req.job;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      if (job.status !== 'COMPLETED') {
        return res.json({
          success: true,
          data: {
            status: job.status,
            message: job.status === 'PROCESSING' ? 'Audit in progress' : 'Audit not started',
          },
        });
      }

      return res.json({
        success: true,
        data: job.output,
      });
    } catch (error) {
      logger.error('Failed to get audit result', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit result',
      });
    }
  },

  async createRemediationPlan(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const plan = await remediationService.createRemediationPlan(jobId);

      return res.json({
        success: true,
        data: plan,
      });
    } catch (error) {
      logger.error('Failed to create remediation plan', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create remediation plan',
      });
    }
  },

  async getRemediationPlan(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const plan = await remediationService.getRemediationPlan(jobId);

      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Remediation plan not found',
        });
      }

      return res.json({
        success: true,
        data: plan,
      });
    } catch (error) {
      logger.error('Failed to get remediation plan', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get remediation plan',
      });
    }
  },

  async getRemediationSummary(req: Request, res: Response) {
    try {
      const { jobId } = req.params;
      const summary = await remediationService.getRemediationSummary(jobId);

      return res.json({
        success: true,
        data: summary,
      });
    } catch (error) {
      logger.error('Failed to get remediation summary', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get remediation summary',
      });
    }
  },

  async updateTaskStatus(req: Request, res: Response) {
    try {
      const { jobId, taskId } = req.params;
      const { status, resolution, resolvedBy } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required',
        });
      }

      const task = await remediationService.updateTaskStatus(
        jobId,
        taskId,
        status,
        resolution,
        resolvedBy
      );

      return res.json({
        success: true,
        data: task,
      });
    } catch (error) {
      logger.error('Failed to update task', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      });
    }
  },

  async runAutoRemediation(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string } | null;
      const fileName = input?.fileName || 'document.epub';

      const epubBuffer = await fileStorageService.getFile(jobId, fileName);
      if (!epubBuffer) {
        return res.status(400).json({
          success: false,
          error: 'EPUB file not found. File may have been deleted or not uploaded.',
        });
      }

      const result = await autoRemediationService.runAutoRemediation(
        epubBuffer,
        jobId,
        fileName
      );

      await fileStorageService.saveRemediatedFile(
        jobId,
        result.remediatedFileName,
        result.remediatedBuffer
      );

      return res.json({
        success: true,
        data: {
          jobId: result.jobId,
          originalFileName: result.originalFileName,
          remediatedFileName: result.remediatedFileName,
          totalIssuesFixed: result.totalIssuesFixed,
          totalIssuesFailed: result.totalIssuesFailed,
          modifications: result.modifications,
          downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        },
      });
    } catch (error) {
      logger.error('Auto-remediation failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Auto-remediation failed',
      });
    }
  },

  async getSupportedFixes(_req: Request, res: Response) {
    try {
      const codes = autoRemediationService.getSupportedIssueCodes();

      return res.json({
        success: true,
        data: {
          supportedCodes: codes,
          descriptions: {
            'EPUB-META-001': 'Add missing language declaration',
            'EPUB-META-002': 'Add accessibility feature metadata',
            'EPUB-META-003': 'Add accessibility summary',
            'EPUB-META-004': 'Add access mode metadata',
            'EPUB-SEM-001': 'Add lang attribute to HTML elements',
            'EPUB-IMG-001': 'Mark images without alt as decorative',
            'EPUB-STRUCT-002': 'Add headers to simple tables',
          },
        },
      });
    } catch (error) {
      logger.error('Failed to get supported fixes', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get supported fixes',
      });
    }
  },

  async downloadRemediatedFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const output = job.output as { autoRemediation?: { remediatedFileName?: string } } | null;
      const remediatedFileName = output?.autoRemediation?.remediatedFileName;

      if (!remediatedFileName) {
        return res.status(404).json({
          success: false,
          error: 'No remediated file available. Run auto-remediation first.',
        });
      }

      const fileBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
      if (!fileBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Remediated file not found on disk',
        });
      }

      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Content-Disposition', `attachment; filename="${remediatedFileName}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      return res.send(fileBuffer);
    } catch (error) {
      logger.error('Failed to download remediated file', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to download remediated file',
      });
    }
  },

  async applySpecificFix(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const { fixCode, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!fixCode) {
        return res.status(400).json({
          success: false,
          error: 'fixCode is required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const originalFileName = input?.fileName || 'upload.epub';
      const epubBuffer = await fileStorageService.getFile(jobId, originalFileName);
      if (!epubBuffer) {
        return res.status(404).json({
          success: false,
          error: 'EPUB file not found',
        });
      }

      const zip = await epubModifier.loadEPUB(epubBuffer);

      type ModificationResult = {
        success: boolean;
        filePath: string;
        modificationType: string;
        description: string;
        before?: string;
        after?: string;
      };
      let results: ModificationResult[] = [];

      switch (fixCode) {
        case 'EPUB-META-001':
          results = [await epubModifier.addLanguage(zip, options?.language)];
          break;
        case 'EPUB-META-002':
          results = await epubModifier.addAccessibilityMetadata(zip, options?.features);
          break;
        case 'EPUB-META-003':
          results = [await epubModifier.addAccessibilitySummary(zip, options?.summary)];
          break;
        case 'EPUB-SEM-001':
          results = await epubModifier.addHtmlLangAttributes(zip, options?.language);
          break;
        case 'EPUB-SEM-002':
          results = await epubModifier.fixEmptyLinks(zip);
          break;
        case 'EPUB-IMG-001':
          if (options?.imageAlts) {
            results = await epubModifier.addAltText(zip, options.imageAlts);
          } else {
            results = await epubModifier.addDecorativeAltAttributes(zip);
          }
          break;
        case 'EPUB-STRUCT-002':
          results = await epubModifier.addTableHeaders(zip);
          break;
        case 'EPUB-STRUCT-003':
          results = await epubModifier.fixHeadingHierarchy(zip);
          break;
        case 'EPUB-STRUCT-004':
          results = await epubModifier.addAriaLandmarks(zip);
          break;
        case 'EPUB-NAV-001':
          results = await epubModifier.addSkipNavigation(zip);
          break;
        case 'EPUB-FIG-001':
          results = await epubModifier.addFigureStructure(zip);
          break;
        default:
          return res.status(400).json({
            success: false,
            error: `Unknown fix code: ${fixCode}`,
          });
      }

      const modifiedBuffer = await epubModifier.saveEPUB(zip);
      const remediatedFileName = originalFileName.replace(/\.epub$/i, '_remediated.epub');
      await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

      return res.json({
        success: true,
        data: {
          fixCode,
          results,
          downloadUrl: `/api/v1/epub/job/${jobId}/download-remediated`,
        },
      });
    } catch (error) {
      logger.error('Failed to apply specific fix', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to apply fix',
      });
    }
  },

  async getComparison(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const fileName = input?.fileName || 'upload.epub';
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);

      if (!originalBuffer || !remediatedBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Both original and remediated files required',
        });
      }

      const comparison = await epubComparisonService.compareEPUBs(
        originalBuffer,
        remediatedBuffer,
        jobId,
        fileName
      );

      return res.json({
        success: true,
        data: comparison,
      });
    } catch (error) {
      logger.error('Failed to generate comparison', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate comparison',
      });
    }
  },

  async getComparisonSummary(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const input = job.input as { fileName?: string };
      const fileName = input?.fileName || 'upload.epub';
      const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);

      if (!originalBuffer || !remediatedBuffer) {
        return res.status(404).json({
          success: false,
          error: 'Both original and remediated files required',
        });
      }

      const comparison = await epubComparisonService.compareEPUBs(
        originalBuffer,
        remediatedBuffer,
        jobId,
        fileName
      );

      return res.json({
        success: true,
        data: {
          jobId: comparison.jobId,
          originalFileName: comparison.originalFileName,
          remediatedFileName: comparison.remediatedFileName,
          summary: comparison.summary,
          modifications: comparison.modifications,
          generatedAt: comparison.generatedAt,
        },
      });
    } catch (error) {
      logger.error('Failed to generate comparison summary', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate comparison',
      });
    }
  },

  async createBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobIds, options } = req.body;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'jobIds array is required',
        });
      }

      if (jobIds.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 100 jobs per batch',
        });
      }

      const batch = await batchRemediationService.createBatch(
        jobIds,
        tenantId,
        userId,
        options || {}
      );

      return res.status(201).json({
        success: true,
        data: batch,
      });
    } catch (error) {
      logger.error('Failed to create batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create batch',
      });
    }
  },

  async startBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const { options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: 'Batch not found',
        });
      }

      if (batch.status !== 'pending') {
        return res.status(400).json({
          success: false,
          error: `Batch cannot be started (status: ${batch.status})`,
        });
      }

      batchRemediationService.processBatch(batchId, tenantId, options || {})
        .catch(err => logger.error(`Batch ${batchId} processing error`, err));

      return res.json({
        success: true,
        data: { ...batch, status: 'processing' },
        message: 'Batch processing started',
      });
    } catch (error) {
      logger.error('Failed to start batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start batch',
      });
    }
  },

  async getBatchStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: 'Batch not found',
        });
      }

      return res.json({
        success: true,
        data: batch,
      });
    } catch (error) {
      logger.error('Failed to get batch status', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get batch status',
      });
    }
  },

  async cancelBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const batch = await batchRemediationService.cancelBatch(batchId, tenantId);

      return res.json({
        success: true,
        data: batch,
        message: 'Batch cancelled',
      });
    } catch (error) {
      logger.error('Failed to cancel batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel batch',
      });
    }
  },

  async listBatches(req: AuthenticatedRequest, res: Response) {
    try {
      const tenantId = req.user?.tenantId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          error: 'Limit must be between 1 and 100',
        });
      }

      const { batches, total } = await batchRemediationService.listBatches(
        tenantId,
        page,
        limit
      );

      return res.json({
        success: true,
        data: {
          batches,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      logger.error('Failed to list batches', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list batches',
      });
    }
  },

  async exportRemediated(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;
      const includeOriginal = req.query.includeOriginal === 'true';
      const includeComparison = req.query.includeComparison === 'true';
      const includeReport = req.query.includeReport === 'true';

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const result = await epubExportService.exportRemediated(jobId, tenantId, {
        includeOriginal,
        includeComparison,
        includeReport,
      });

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.size);

      return res.send(result.buffer);
    } catch (error) {
      logger.error('Failed to export remediated EPUB', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export',
      });
    }
  },

  async exportBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobIds, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'jobIds array is required',
        });
      }

      if (jobIds.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 100 jobs per export',
        });
      }

      const result = await epubExportService.exportBatch(jobIds, tenantId, options || {});

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.size);

      return res.send(result.buffer);
    } catch (error) {
      logger.error('Failed to export batch', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export batch',
      });
    }
  },

  async getAccessibilityReport(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;
      const format = req.query.format as string || 'json';

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const report = await epubExportService.generateAccessibilityReport(jobId, tenantId);

      if (format === 'md' || format === 'markdown') {
        const md = epubExportService.generateReportMarkdown(report);
        res.setHeader('Content-Type', 'text/markdown');
        return res.send(md);
      }

      return res.json({
        success: true,
        data: report,
      });
    } catch (error) {
      logger.error('Failed to generate report', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate report',
      });
    }
  },
};
