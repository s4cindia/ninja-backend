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
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { resolveDocumentSimple } from './document-resolver';
import { buildRefIdToNumberMap, formatCitationWithChanges } from '../../utils/citation.utils';

export class CitationExportController {
  /**
   * GET /api/v1/citation-management/document/:documentId/preview
   * Preview changes that will be applied on export
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async previewChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Previewing changes for document ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const document = await resolveDocumentSimple(documentId, tenantId);

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Use the resolved document ID for subsequent queries
      const resolvedDocId = document.id;

      // Get all changes
      const changes = await prisma.citationChange.findMany({
        where: {
          documentId: resolvedDocId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Get citations with their reference links for frontend display
      const citations = await prisma.citation.findMany({
        where: { documentId: resolvedDocId },
        include: {
          referenceListEntries: {
            include: { referenceListEntry: true }
          }
        },
        orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }]
      });

      // Get references for building number map
      const references = await prisma.referenceListEntry.findMany({
        where: { documentId: resolvedDocId },
        orderBy: { sortKey: 'asc' }
      });

      // Build ref ID to number map using shared utility
      const refIdToNumber = buildRefIdToNumberMap(references);

      // Build citation ID to change map
      const citationToChange = new Map<string, typeof changes[0]>();
      for (const change of changes) {
        if (change.citationId) {
          citationToChange.set(change.citationId, change);
        }
      }

      // Format citations for frontend with change info using shared utility
      const formattedCitations = citations.map(c => {
        const change = citationToChange.get(c.id);
        return formatCitationWithChanges(
          c,
          refIdToNumber,
          change ? {
            changeType: change.changeType,
            beforeText: change.beforeText,
            afterText: change.afterText
          } : undefined
        );
      });

      // Group changes by type (for backward compatibility)
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
        })),
        totalCitations: citations.length,
        citationsWithChanges: formattedCitations.filter(c => c.changeType !== 'unchanged').length,
        orphanedCitations: formattedCitations.filter(c => c.isOrphaned).length
      };

      res.json({
        success: true,
        data: {
          documentId: resolvedDocId,
          documentName: document.originalName,
          currentStyle: document.referenceListStyle,
          summary,
          changes: changesByType,
          // Add citations array for frontend track changes display
          citations: formattedCitations
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
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async exportDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Exporting document ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Use resolved document ID for subsequent queries
      const resolvedDocId = baseDoc.id;

      // Get document with full relations
      const document = await prisma.editorialDocument.findFirst({
        where: { id: resolvedDocId, tenantId },
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
          documentId: resolvedDocId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Read original DOCX file using storage service (handles S3/local automatically)
      let originalBuffer: Buffer;
      try {
        originalBuffer = await citationStorageService.getFileBuffer(
          document.storagePath,
          document.storageType as 'S3' | 'LOCAL'
        );
      } catch (readError) {
        logger.error(`[CitationExport] Cannot read original file: ${document.storagePath}`, readError);
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Original document file not found' }
        });
        return;
      }

      // Build the changes array for the docx processor
      // This includes in-text citation changes AND reference section updates
      const changesToApply: Array<{
        type: string;
        beforeText: string;
        afterText: string;
        metadata?: Record<string, unknown> | null;
      }> = [];

      // Helper function to generate basic APA-style formatted text from components
      const generateBasicFormatted = (values: Record<string, unknown>): string => {
        const authors = values.authors as string[] | undefined;
        const year = values.year as string | undefined;
        const title = values.title as string | undefined;
        const journalName = values.journalName as string | undefined;
        const volume = values.volume as string | undefined;
        const issue = values.issue as string | undefined;
        const pages = values.pages as string | undefined;
        const doi = values.doi as string | undefined;
        const publisher = values.publisher as string | undefined;

        let formatted = '';

        // Authors
        if (authors && authors.length > 0) {
          formatted = authors.join(', ');
        }

        // Year
        if (year) {
          formatted += formatted ? ` (${year}). ` : `(${year}). `;
        } else if (formatted) {
          formatted += '. ';
        }

        // Title
        if (title) {
          formatted += title;
          if (!title.endsWith('.') && !title.endsWith('?') && !title.endsWith('!')) {
            formatted += '.';
          }
          formatted += ' ';
        }

        // Journal/Publisher
        if (journalName) {
          formatted += journalName;
          if (volume) {
            formatted += `, ${volume}`;
            if (issue) {
              formatted += `(${issue})`;
            }
          }
          if (pages) {
            formatted += `, ${pages}`;
          }
          formatted += '.';
        } else if (publisher) {
          formatted += publisher + '.';
        }

        // DOI
        if (doi) {
          formatted += ` https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, '')}`;
        }

        return formatted.trim();
      };

      // Process each change
      for (const c of changes) {
        // For REFERENCE_EDIT changes, we need to handle both:
        // 1. In-text citation updates (citationId is set)
        // 2. Reference section updates (citationId is null)
        if (c.changeType === 'REFERENCE_EDIT' && !c.citationId && c.metadata) {
          // This is a reference-level change - need to update the reference section
          const metadata = c.metadata as Record<string, unknown>;
          const referenceId = metadata.referenceId as string;
          const oldValues = metadata.oldValues as Record<string, unknown>;

          if (referenceId && oldValues) {
            // Find the current reference to get the new formatted text
            const currentRef = document.referenceListEntries.find(r => r.id === referenceId);
            if (currentRef) {
              // Determine which formatted field to use based on document style
              const styleCode = document.referenceListStyle?.toLowerCase() || 'apa';
              let oldFormatted: string | undefined;
              let newFormatted: string | undefined;

              if (styleCode.includes('mla')) {
                oldFormatted = oldValues.formattedMla as string;
                newFormatted = currentRef.formattedMla || undefined;
              } else if (styleCode.includes('chicago')) {
                oldFormatted = oldValues.formattedChicago as string;
                newFormatted = currentRef.formattedChicago || undefined;
              } else if (styleCode.includes('vancouver')) {
                oldFormatted = oldValues.formattedVancouver as string;
                newFormatted = currentRef.formattedVancouver || undefined;
              } else if (styleCode.includes('ieee')) {
                oldFormatted = oldValues.formattedIeee as string;
                newFormatted = currentRef.formattedIeee || undefined;
              } else {
                // Default to APA
                oldFormatted = oldValues.formattedApa as string;
                newFormatted = currentRef.formattedApa || undefined;
              }

              // If oldFormatted is NULL (reference was never formatted), generate from components
              // WARNING: This fallback generates basic APA-style formatting which may differ
              // from the style-specific formatting shown in the UI (referenceListService.formatReference)
              if (!oldFormatted && oldValues) {
                oldFormatted = generateBasicFormatted(oldValues);
                logger.warn(`[CitationExport] Using fallback formatting for old reference - may differ from UI. Generated: "${oldFormatted.substring(0, 80)}..."`);
              }

              // If newFormatted is NULL, generate from current reference
              // WARNING: This fallback generates basic APA-style formatting which may differ
              // from the style-specific formatting shown in the UI (referenceListService.formatReference)
              if (!newFormatted && currentRef) {
                newFormatted = generateBasicFormatted({
                  authors: currentRef.authors as string[] | undefined,
                  year: currentRef.year,
                  title: currentRef.title,
                  journalName: currentRef.journalName,
                  volume: currentRef.volume,
                  issue: currentRef.issue,
                  pages: currentRef.pages,
                  doi: currentRef.doi,
                  publisher: currentRef.publisher
                });
                logger.warn(`[CitationExport] Using fallback formatting for new reference - may differ from UI. Generated: "${newFormatted.substring(0, 80)}..."`);
              }

              if (oldFormatted && newFormatted && oldFormatted !== newFormatted) {
                logger.info(`[CitationExport] Adding reference section change: "${oldFormatted.substring(0, 50)}..." -> "${newFormatted.substring(0, 50)}..."`);
                changesToApply.push({
                  type: 'REFERENCE_SECTION_EDIT',
                  beforeText: oldFormatted,
                  afterText: newFormatted,
                  metadata: { referenceId, isReferenceSection: true }
                });
              } else {
                logger.info(`[CitationExport] Skipping reference section change - oldFormatted: ${!!oldFormatted}, newFormatted: ${!!newFormatted}, same: ${oldFormatted === newFormatted}`);
              }
            }
          }
        }

        // Add the change (in-text citation change or other types)
        changesToApply.push({
          type: c.changeType,
          beforeText: c.beforeText || '',
          afterText: c.afterText || '',
          metadata: c.metadata as Record<string, unknown> | null
        });
      }

      // Apply changes using docx processor
      let modifiedBuffer: Buffer;
      try {
        modifiedBuffer = await docxProcessorService.applyChanges(originalBuffer, changesToApply);
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
