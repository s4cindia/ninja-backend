/**
 * Validator Controller
 * Handles document upload and management for the Validator feature
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { citationStorageService } from '../../services/citation/citation-storage.service';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class ValidatorController {
  /**
   * POST /api/v1/validator/upload
   * Upload a DOCX file for editing
   */
  async upload(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
        return;
      }

      logger.info(`[Validator] Uploading file: ${file.originalname}`);

      // Upload to storage
      const storageResult = await citationStorageService.uploadFile(
        tenantId,
        file.originalname,
        file.buffer,
        file.mimetype
      );

      // Extract filename from storage path
      const storedFileName = path.basename(storageResult.storagePath) || file.originalname;

      // Create a Job record (required by EditorialDocument)
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EDITORIAL_FULL',
          status: 'COMPLETED',
          input: {
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: DOCX_MIME_TYPE,
            source: 'validator',
          },
        },
      });

      // Create document record
      const document = await prisma.editorialDocument.create({
        data: {
          tenantId,
          jobId: job.id,
          fileName: storedFileName,
          originalName: file.originalname,
          mimeType: DOCX_MIME_TYPE,
          fileSize: file.size,
          storagePath: storageResult.storagePath,
          storageType: storageResult.storageType,
          status: 'UPLOADED',
          wordCount: 0,
          authors: [],
        },
      });

      logger.info(`[Validator] Document created: ${document.id}`);

      res.status(201).json({
        success: true,
        data: {
          documentId: document.id,
          jobId: job.id,
          fileName: document.originalName,
          fileSize: document.fileSize,
          status: document.status,
        },
      });
    } catch (error) {
      logger.error('[Validator] Upload failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents
   * List documents for the current tenant
   */
  async listDocuments(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const [documents, total] = await Promise.all([
        prisma.editorialDocument.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            fileName: true,
            originalName: true,
            fileSize: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.editorialDocument.count({ where: { tenantId } }),
      ]);

      res.json({
        success: true,
        data: {
          documents,
          total,
          limit,
          offset,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents/:documentId
   * Get document details
   */
  async getDocument(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const { documentId } = req.params;

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: {
          id: true,
          fileName: true,
          originalName: true,
          fileSize: true,
          mimeType: true,
          status: true,
          wordCount: true,
          pageCount: true,
          title: true,
          authors: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: document,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const validatorController = new ValidatorController();
