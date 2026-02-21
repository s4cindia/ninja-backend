/**
 * Document Version Controller
 * Handles document versioning and track changes operations
 *
 * Endpoints:
 * - GET /document/:documentId/versions - List all versions
 * - GET /document/:documentId/versions/:version - Get specific version
 * - GET /document/:documentId/versions/latest - Get latest version
 * - POST /document/:documentId/versions - Create new version
 * - GET /document/:documentId/versions/compare - Compare two versions
 * - POST /document/:documentId/versions/:version/restore - Restore to version
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
  documentVersioningService,
  DocumentSnapshot,
} from '../../services/document/document-versioning.service';

export class DocumentVersionController {
  /**
   * GET /api/v1/document/:documentId/versions
   * List all versions of a document
   */
  async listVersions(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const { versions, total } = await documentVersioningService.getVersions(
        documentId,
        { limit, offset }
      );

      res.json({
        success: true,
        data: {
          documentId,
          versions: versions.map((v) => ({
            id: v.id,
            version: v.version,
            createdAt: v.createdAt,
            createdBy: v.createdBy,
            changeLogSummary: `${v.changeLog.length} changes`,
            snapshotType: v.snapshotType,
          })),
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
   * GET /api/v1/document/:documentId/versions/latest
   * Get the latest version
   */
  async getLatestVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const version =
        await documentVersioningService.getLatestVersion(documentId);

      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No versions found' },
        });
        return;
      }

      res.json({
        success: true,
        data: version,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/document/:documentId/versions/:version
   * Get a specific version
   */
  async getVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId, version } = req.params;
      const { tenantId } = req.user!;
      const versionNum = parseInt(version, 10);

      if (isNaN(versionNum)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_VERSION', message: 'Version must be a number' },
        });
        return;
      }

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const versionData = await documentVersioningService.getVersion(
        documentId,
        versionNum
      );

      if (!versionData) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Version not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: versionData,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/versions
   * Create a new version (manual snapshot)
   */
  async createVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { reason } = req.body;
      const { tenantId, id: userId } = req.user!;

      logger.info(`[DocumentVersion] Creating version for document ${documentId}`);

      // Get document with content
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          documentContent: true,
          references: {
            select: { id: true, rawText: true, refNumber: true },
          },
          citations: {
            select: { id: true, rawText: true, referenceId: true },
          },
          styleViolations: {
            where: { status: 'PENDING' },
          },
        },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      // Build snapshot
      const snapshot: DocumentSnapshot = {
        documentId: document.id,
        content: document.documentContent?.fullText || '',
        metadata: {
          wordCount: document.wordCount,
          pageCount: document.pageCount || undefined,
          title: document.title || undefined,
          authors: document.authors,
          language: document.language || undefined,
        },
        references: document.references.map((r) => ({
          id: r.id,
          rawText: r.rawText,
          refNumber: r.refNumber || undefined,
        })),
        citations: document.citations.map((c) => ({
          id: c.id,
          rawText: c.rawText,
          referenceId: c.referenceId || undefined,
        })),
        styleViolationCount: document.styleViolations.length,
      };

      const version = await documentVersioningService.createVersion(
        documentId,
        snapshot,
        userId,
        reason
      );

      res.status(201).json({
        success: true,
        data: {
          id: version.id,
          version: version.version,
          createdAt: version.createdAt,
          changeLogSummary: `${version.changeLog.length} changes`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/document/:documentId/versions/compare
   * Compare two versions
   */
  async compareVersions(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { versionA, versionB } = req.query;
      const { tenantId } = req.user!;

      const vA = parseInt(versionA as string, 10);
      const vB = parseInt(versionB as string, 10);

      if (isNaN(vA) || isNaN(vB)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_VERSIONS',
            message: 'versionA and versionB must be numbers',
          },
        });
        return;
      }

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const comparison = await documentVersioningService.compareVersions(
        documentId,
        vA,
        vB
      );

      if (!comparison) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'One or both versions not found',
          },
        });
        return;
      }

      res.json({
        success: true,
        data: comparison,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/versions/:version/restore
   * Restore document to a specific version
   */
  async restoreVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId, version } = req.params;
      const { tenantId, id: userId } = req.user!;
      const versionNum = parseInt(version, 10);

      if (isNaN(versionNum)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_VERSION', message: 'Version must be a number' },
        });
        return;
      }

      logger.info(
        `[DocumentVersion] Restoring document ${documentId} to version ${versionNum}`
      );

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const restoredVersion = await documentVersioningService.restoreVersion(
        documentId,
        versionNum,
        userId
      );

      if (!restoredVersion) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Version not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          message: `Document restored to version ${versionNum}`,
          newVersion: restoredVersion.version,
          restoredFrom: versionNum,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const documentVersionController = new DocumentVersionController();
