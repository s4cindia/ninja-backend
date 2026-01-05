import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { FileStatus } from '@prisma/client';
import { fileService } from '../services/file.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { ListFilesQuery } from '../schemas/file.schemas';
import prisma from '../lib/prisma';
import { epubAuditService } from '../services/epub/epub-audit.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../lib/logger';

class FileController {
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        throw AppError.badRequest('No file uploaded', ErrorCodes.FILE_UPLOAD_FAILED);
      }

      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const file = await fileService.createFile({
        originalName: req.file.originalname,
        filename: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        tenantId: req.user.tenantId,
      });

      res.status(201).json({
        success: true,
        data: file,
      });
    } catch (error) {
      next(error);
    }
  }

  async getFile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const file = await fileService.getFileById(req.params.id, req.user.tenantId);

      res.status(200).json({
        success: true,
        data: file,
      });
    } catch (error) {
      next(error);
    }
  }

  async downloadFile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const file = await fileService.getFileById(req.params.id, req.user.tenantId);

      if (!fs.existsSync(file.path)) {
        throw AppError.notFound('File not found on disk', ErrorCodes.FILE_NOT_FOUND);
      }

      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', file.size);

      const fileStream = fs.createReadStream(file.path);
      fileStream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  async deleteFile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const result = await fileService.deleteFile(req.params.id, req.user.tenantId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async listFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const files = await fileService.getFilesByTenant(req.user.tenantId);

      res.status(200).json({
        success: true,
        data: files,
      });
    } catch (error) {
      next(error);
    }
  }

  async listAdvanced(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const query = req.query as unknown as ListFilesQuery;
      
      const result = await fileService.listFilesAdvanced(req.user.tenantId, {
        page: query.page,
        limit: query.limit,
        status: query.status as FileStatus | undefined,
        mimeType: query.mimeType,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });

      res.status(200).json({
        success: true,
        data: result.files,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const stats = await fileService.getFileStats(req.user.tenantId);

      res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const { status, metadata } = req.body;
      
      const file = await fileService.updateFileStatus(
        req.params.id,
        req.user.tenantId,
        status as FileStatus,
        metadata
      );

      res.status(200).json({
        success: true,
        data: file,
      });
    } catch (error) {
      next(error);
    }
  }

  async triggerAudit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      const file = await fileService.getFileById(req.params.id, req.user.tenantId);

      // Check if file is EPUB
      if (!file.mimeType.includes('epub') && !file.originalName.toLowerCase().endsWith('.epub')) {
        throw AppError.badRequest('Only EPUB files can be audited', ErrorCodes.FILE_UPLOAD_FAILED);
      }

      // Check if already processing
      if (file.status === 'PROCESSING') {
        throw AppError.badRequest('File is already being processed', ErrorCodes.VALIDATION_ERROR);
      }

      // Use transaction to ensure atomicity
      const job = await prisma.$transaction(async (tx) => {
        // Update file status to PROCESSING
        await tx.file.update({
          where: { id: file.id },
          data: { status: 'PROCESSING' },
        });

        // Create audit job
        return tx.job.create({
          data: {
            tenantId: req.user!.tenantId,
            userId: req.user!.id,
            type: 'EPUB_ACCESSIBILITY',
            status: 'PROCESSING',
            input: {
              fileId: file.id,
              fileName: file.originalName,
              filePath: file.path,
            },
            startedAt: new Date(),
          },
        });
      });

      // Run audit asynchronously
      this.runAuditAsync(
        { id: file.id, path: file.path, originalName: file.originalName, storageType: file.storageType },
        job.id,
        req.user.tenantId
      ).catch(err => {
        logger.error(`Async audit failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      });

      res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          fileId: file.id,
          status: 'PROCESSING'
        },
      });
    } catch (error) {
      next(error);
    }
  }

  private async runAuditAsync(
    file: { id: string; path: string; originalName: string; storageType?: string },
    jobId: string,
    tenantId: string
  ): Promise<void> {
    try {
      let fileBuffer: Buffer;

      // Handle S3 vs local storage
      if (file.storageType === 'S3') {
        fileBuffer = await s3Service.getFileBuffer(file.path);
      } else {
        fileBuffer = await fsPromises.readFile(file.path);
      }

      // Save to job storage for later remediation
      await fileStorageService.saveFile(jobId, file.originalName, fileBuffer);

      // Run the EPUB audit
      const result = await epubAuditService.runAudit(
        fileBuffer,
        jobId,
        file.originalName
      );

      // Update job to COMPLETED
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: JSON.parse(JSON.stringify(result)),
        },
      });

      // Update file status to PROCESSED
      await fileService.updateFileStatus(file.id, tenantId, 'PROCESSED' as FileStatus);

      logger.info(`Audit completed for file ${file.id}, job ${jobId}`);
    } catch (error) {
      logger.error(`Audit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Update job to FAILED
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      }).catch(() => {});

      // Update file status to ERROR
      await fileService.updateFileStatus(file.id, tenantId, 'ERROR' as FileStatus).catch(() => {});
    }
  }
}

export const fileController = new FileController();
