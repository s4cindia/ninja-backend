import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { FileStatus } from '@prisma/client';
import { fileService } from '../services/file.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { ListFilesQuery } from '../schemas/file.schemas';
import prisma from '../lib/prisma';

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
      const { id } = req.params;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const file = await prisma.file.findFirst({
        where: { id, tenantId, deletedAt: null }
      });

      if (!file) {
        res.status(404).json({ success: false, error: 'File not found' });
        return;
      }

      if (!file.mimeType.includes('epub')) {
        res.status(400).json({ success: false, error: 'Only EPUB files can be audited' });
        return;
      }

      if (file.status === 'PROCESSING') {
        res.status(400).json({ success: false, error: 'File is already being processed' });
        return;
      }

      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EPUB_ACCESSIBILITY',
          status: 'QUEUED',
          input: {
            fileId: file.id,
            fileName: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            storageType: file.storageType,
            storagePath: file.storagePath || file.path,
          },
        },
      });

      await prisma.file.update({
        where: { id },
        data: { status: 'PROCESSING' }
      });

      res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          fileId: file.id,
          status: 'QUEUED',
          message: 'Audit job queued. Poll GET /api/v1/jobs/:jobId for status.',
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const fileController = new FileController();
