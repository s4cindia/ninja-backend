import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { fileService } from '../services/file.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';

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
}

export const fileController = new FileController();
