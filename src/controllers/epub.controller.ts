import { Request, Response } from 'express';
import { epubAuditService } from '../services/epub/epub-audit.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

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

  async auditFromBuffer(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No EPUB file uploaded',
        });
      }

      const tenantId = (req as unknown as { user?: { tenantId?: string } }).user?.tenantId;
      const userId = (req as unknown as { user?: { id?: string } }).user?.id;

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

      const result = await epubAuditService.runAudit(
        req.file.buffer,
        job.id,
        req.file.originalname
      );

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('EPUB audit from buffer failed', error instanceof Error ? error : undefined);
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
};
