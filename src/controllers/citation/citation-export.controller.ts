/**
 * Citation Export Controller
 * Handles document export and preview operations
 *
 * Endpoints:
 * - GET /document/:documentId/preview - Preview changes
 * - GET /document/:documentId/export - Export modified DOCX
 * - GET /document/:documentId/export-debug - Debug export (dev only)
 * - POST /document/:documentId/debug-style-conversion - Debug style conversion (dev only)
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { docxProcessorService } from '../../services/citation/docx-processor.service';

export class CitationExportController {
  /**
   * GET /api/v1/citation-management/document/:documentId/preview
   * Preview changes that will be applied on export
   */
  async previewChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Previewing changes for document ${documentId}`);

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: {
          id: true,
          originalName: true,
          referenceListStyle: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get all changes
      const changes = await prisma.citationChange.findMany({
        where: {
          documentId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Group changes by type
      const changesByType: Record<string, Array<{
        id: string;
        beforeText: string | null;
        afterText: string | null;
        citationId: string | null;
      }>> = {};

      for (const change of changes) {
        const type = change.changeType;
        if (!changesByType[type]) {
          changesByType[type] = [];
        }
        changesByType[type].push({
          id: change.id,
          beforeText: change.beforeText,
          afterText: change.afterText,
          citationId: change.citationId
        });
      }

      // Summary
      const summary = {
        totalChanges: changes.length,
        byType: Object.entries(changesByType).map(([type, items]) => ({
          type,
          count: items.length
        }))
      };

      res.json({
        success: true,
        data: {
          documentId,
          documentName: document.originalName,
          currentStyle: document.referenceListStyle,
          summary,
          changes: changesByType
        }
      });
    } catch (error) {
      logger.error('[CitationExport] Preview failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/export
   * Export modified DOCX with preserved formatting
   */
  async exportDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Exporting document ${documentId}`);

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get all changes to apply
      const changes = await prisma.citationChange.findMany({
        where: {
          documentId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Read original DOCX file
      const fs = await import('fs/promises');
      const path = await import('path');
      const originalPath = path.join(process.cwd(), 'uploads', document.storagePath);

      let originalBuffer: Buffer;
      try {
        originalBuffer = await fs.readFile(originalPath);
      } catch {
        logger.error(`[CitationExport] Cannot read original file: ${originalPath}`);
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Original document file not found' }
        });
        return;
      }

      // Apply changes using docx processor
      let modifiedBuffer: Buffer;
      try {
        modifiedBuffer = await docxProcessorService.applyChanges(originalBuffer, changes.map(c => ({
          type: c.changeType as 'RENUMBER' | 'REFERENCE_STYLE_CONVERSION' | 'DELETE' | 'INSERT',
          beforeText: c.beforeText || '',
          afterText: c.afterText || ''
        })));
      } catch (applyError) {
        logger.error('[CitationExport] Failed to apply changes:', applyError);
        // Return original document if modification fails
        modifiedBuffer = originalBuffer;
      }

      // Generate filename
      const baseName = document.originalName.replace(/\.docx$/i, '');
      const exportName = `${baseName}_modified.docx`;

      // Send file
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportName)}"`);
      res.setHeader('Content-Length', modifiedBuffer.length);
      res.send(modifiedBuffer);
    } catch (error) {
      logger.error('[CitationExport] Export failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/export-debug
   * Debug endpoint to check document state before export (DEVELOPMENT ONLY)
   */
  async exportDebug(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      // Get document with all related data
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const changes = await prisma.citationChange.findMany({
        where: { documentId },
        orderBy: { appliedAt: 'asc' }
      });

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            originalName: document.originalName,
            storagePath: document.storagePath,
            status: document.status,
            referenceListStyle: document.referenceListStyle
          },
          citations: document.citations.length,
          references: document.referenceListEntries.length,
          changes: changes.map(c => ({
            id: c.id,
            type: c.changeType,
            beforeText: c.beforeText?.substring(0, 50),
            afterText: c.afterText?.substring(0, 50),
            isReverted: c.isReverted
          })),
          totalActiveChanges: changes.filter(c => !c.isReverted).length
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/debug-style-conversion
   * Debug endpoint to test style conversion (DEVELOPMENT ONLY)
   */
  async debugStyleConversion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { referenceId, targetStyle } = req.body;
      const { tenantId } = req.user!;

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get the specific reference
      const reference = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId }
      });

      if (!reference || reference.documentId !== documentId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          referenceId: reference.id,
          originalText: reference.formattedApa || reference.title,
          targetStyle,
          components: {
            authors: reference.authors,
            year: reference.year,
            title: reference.title,
            journal: reference.journalName,
            volume: reference.volume,
            issue: reference.issue,
            pages: reference.pages,
            doi: reference.doi
          },
          message: 'Debug info - use convert-style endpoint for actual conversion'
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const citationExportController = new CitationExportController();
