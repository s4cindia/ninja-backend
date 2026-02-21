/**
 * Track Changes Controller
 * Handles document change tracking and review operations
 *
 * Endpoints:
 * - GET /document/:documentId/changes - List all changes
 * - GET /document/:documentId/changes/pending - List pending changes
 * - GET /document/:documentId/changes/stats - Get change statistics
 * - POST /document/:documentId/changes - Create a change
 * - PATCH /change/:changeId/accept - Accept a change
 * - PATCH /change/:changeId/reject - Reject a change
 * - POST /document/:documentId/changes/bulk - Bulk accept/reject
 * - POST /document/:documentId/changes/accept-all - Accept all pending
 * - POST /document/:documentId/changes/reject-all - Reject all pending
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DocumentChangeType, DocumentChangeStatus } from '@prisma/client';
import {
  trackChangesService,
  CreateChangeInput,
} from '../../services/document/track-changes.service';

export class TrackChangesController {
  /**
   * GET /api/v1/document/:documentId/changes
   * List all changes for a document
   */
  async listChanges(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { status } = req.query;
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

      const changeStatus = status
        ? (status as DocumentChangeStatus)
        : undefined;
      const changes = await trackChangesService.getChangesByDocument(
        documentId,
        changeStatus
      );

      res.json({
        success: true,
        data: {
          documentId,
          changes,
          total: changes.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/document/:documentId/changes/pending
   * List pending changes for a document
   */
  async listPendingChanges(
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

      const changes = await trackChangesService.getPendingChanges(documentId);

      res.json({
        success: true,
        data: {
          documentId,
          changes,
          total: changes.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/document/:documentId/changes/stats
   * Get change statistics for a document
   */
  async getChangeStats(
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

      const stats = await trackChangesService.getChangeStats(documentId);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/changes
   * Create a new tracked change
   */
  async createChange(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const {
        changeType,
        startOffset,
        endOffset,
        beforeText,
        afterText,
        reason,
        sourceType,
        metadata,
      } = req.body;
      const { tenantId, id: userId } = req.user!;

      logger.info(`[TrackChanges] Creating change for document ${documentId}`);

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

      const input: CreateChangeInput = {
        documentId,
        changeType: changeType as DocumentChangeType,
        startOffset,
        endOffset,
        beforeText,
        afterText,
        reason,
        sourceType,
        metadata,
        createdBy: userId,
      };

      const change = await trackChangesService.createChange(input);

      res.status(201).json({
        success: true,
        data: change,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/change/:changeId/accept
   * Accept a change
   */
  async acceptChange(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { changeId } = req.params;
      const { id: userId, tenantId } = req.user!;

      logger.info(`[TrackChanges] Accepting change ${changeId}`);

      // Get change and verify tenant access
      const existingChange = await trackChangesService.getChange(changeId);
      if (!existingChange) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Change not found' },
        });
        return;
      }

      // Verify document belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: existingChange.documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const change = await trackChangesService.acceptChange(changeId, userId);

      res.json({
        success: true,
        data: change,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/v1/change/:changeId/reject
   * Reject a change
   */
  async rejectChange(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { changeId } = req.params;
      const { id: userId, tenantId } = req.user!;

      logger.info(`[TrackChanges] Rejecting change ${changeId}`);

      // Get change and verify tenant access
      const existingChange = await trackChangesService.getChange(changeId);
      if (!existingChange) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Change not found' },
        });
        return;
      }

      // Verify document belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: existingChange.documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const change = await trackChangesService.rejectChange(changeId, userId);

      res.json({
        success: true,
        data: change,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/changes/bulk
   * Bulk accept/reject changes
   */
  async bulkAction(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { changeIds, action } = req.body;
      const { tenantId, id: userId } = req.user!;

      logger.info(
        `[TrackChanges] Bulk ${action} ${changeIds.length} changes for document ${documentId}`
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

      const changes = await trackChangesService.processBulkAction({
        changeIds,
        action,
        reviewedBy: userId,
      });

      res.json({
        success: true,
        data: {
          processed: changes.length,
          action,
          changes,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/changes/accept-all
   * Accept all pending changes
   */
  async acceptAllPending(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId, id: userId } = req.user!;

      logger.info(
        `[TrackChanges] Accepting all pending changes for document ${documentId}`
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

      const count = await trackChangesService.acceptAllPending(
        documentId,
        userId
      );

      res.json({
        success: true,
        data: {
          accepted: count,
          message: `Accepted ${count} pending changes`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/document/:documentId/changes/reject-all
   * Reject all pending changes
   */
  async rejectAllPending(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId, id: userId } = req.user!;

      logger.info(
        `[TrackChanges] Rejecting all pending changes for document ${documentId}`
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

      const count = await trackChangesService.rejectAllPending(
        documentId,
        userId
      );

      res.json({
        success: true,
        data: {
          rejected: count,
          message: `Rejected ${count} pending changes`,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const trackChangesController = new TrackChangesController();
