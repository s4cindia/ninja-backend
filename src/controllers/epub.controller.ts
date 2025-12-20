import { Request, Response } from 'express';
import { epubAuditService } from '../services/epub/epub-audit.service';
import { remediationService } from '../services/epub/remediation.service';
import { autoRemediationService } from '../services/epub/auto-remediation.service';
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
      const { jobId } = req.params;

      const job = await prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
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
      const { jobId } = req.params;

      const job = await prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Audit result not found',
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

      const input = job.input as { fileName?: string; buffer?: string } | null;
      if (!input?.buffer) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file buffer found in job',
        });
      }

      const epubBuffer = Buffer.from(input.buffer, 'base64');
      const fileName = input.fileName || 'document.epub';

      const result = await autoRemediationService.runAutoRemediation(
        epubBuffer,
        jobId,
        fileName
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
          remediatedFileBase64: result.remediatedBuffer.toString('base64'),
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
};
