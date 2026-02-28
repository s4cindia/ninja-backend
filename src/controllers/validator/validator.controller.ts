/**
 * Validator Controller
 * Handles document upload and management for the Validator feature
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import prisma, { Prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { docxConversionService } from '../../services/document/docx-conversion.service';
import { contentTypeDetector } from '../../services/content-type/content-type-detector.service';
import { htmlToPlainText } from '../../utils/html-to-text';

const SUPPORTED_MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

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

      // Determine mime type (use actual or normalize based on extension)
      const ext = path.extname(file.originalname).toLowerCase();
      const mimeType = ext === '.pdf' ? SUPPORTED_MIME_TYPES.pdf : SUPPORTED_MIME_TYPES.docx;

      // Create a Job record (required by EditorialDocument)
      // Note: Validator uploads are direct-to-editor without processing,
      // so we mark as QUEUED initially. The job serves as a tracking record
      // for the document lifecycle rather than representing actual processing.
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EDITORIAL_FULL',
          status: 'QUEUED',
          input: {
            fileName: file.originalname,
            fileSize: file.size,
            mimeType,
            source: 'validator',
            directUpload: true, // Flag indicating no processing required
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
          mimeType,
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

      // Parse and validate limit/offset with proper clamping
      const parsedLimit = parseInt(req.query.limit as string, 10);
      const parsedOffset = parseInt(req.query.offset as string, 10);
      const limit = isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100);
      const offset = isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

      // Filter to only return documents uploaded via validator (not citation management)
      // Validator uploads have job type EDITORIAL_FULL with source: 'validator' in input
      const whereClause = {
        tenantId,
        job: {
          is: {
            type: 'EDITORIAL_FULL' as const,
            input: {
              path: ['source'],
              equals: 'validator',
            },
          },
        },
      };

      const [documents, total] = await Promise.all([
        prisma.editorialDocument.findMany({
          where: whereClause,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            fileName: true,
            originalName: true,
            fileSize: true,
            wordCount: true,
            pageCount: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            job: {
              select: {
                createdAt: true,
                completedAt: true,
              },
            },
          },
        }),
        prisma.editorialDocument.count({ where: whereClause }),
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

  /**
   * GET /api/v1/validator/documents/:documentId/content
   * Get document content as HTML for editing
   */
  async getDocumentContent(
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
          status: true,
          jobId: true,
          storagePath: true,
          storageType: true,
          originalName: true,
          fileSize: true,
          wordCount: true,
          contentType: true,
          documentContent: {
            select: {
              fullHtml: true,
              fullText: true,
            },
          },
          job: {
            select: {
              createdAt: true,
              completedAt: true,
            },
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

      // Auto-detect content type if unknown
      let detectedContentType = document.contentType;
      if (detectedContentType === 'UNKNOWN' && document.documentContent?.fullHtml) {
        const plainText = document.documentContent.fullText || '';
        const detection = contentTypeDetector.detectContentType(plainText, document.documentContent.fullHtml);
        if (detection.contentType !== 'UNKNOWN') {
          detectedContentType = detection.contentType;
          // Conditional update: only write if still UNKNOWN (prevents race between concurrent requests)
          await prisma.editorialDocument.updateMany({
            where: { id: documentId, contentType: 'UNKNOWN' },
            data: { contentType: detection.contentType },
          });
          logger.debug(`[ContentType] Detected ${detection.contentType} for ${documentId} (signals: ${detection.signals.join(', ')})`);
        }
      }

      // If we have cached HTML content, return it
      if (document.documentContent?.fullHtml) {
        logger.info(`[Validator] Returning cached HTML for document: ${documentId}`);

        // Mark document as PARSED if still UPLOADED (backfill for docs cached before this code)
        // Hoist updated values so the response can use them instead of the stale snapshot
        let backfilledWordCount: number | null = null;
        let backfilledCompletedAt: Date | null = null;
        if (document.status === 'UPLOADED') {
          const now = new Date();
          backfilledWordCount = document.documentContent.fullHtml
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean).length;
          backfilledCompletedAt = now;
          const txOps: Prisma.PrismaPromise<unknown>[] = [
            prisma.editorialDocument.update({
              where: { id: documentId },
              data: { status: 'PARSED', wordCount: backfilledWordCount, updatedAt: now },
            }),
          ];
          if (document.jobId) {
            txOps.push(
              prisma.job.update({
                where: { id: document.jobId },
                data: { status: 'COMPLETED', completedAt: now },
              })
            );
          }
          await prisma.$transaction(txOps);
          logger.info(`[Validator] Backfilled document ${documentId} as PARSED, wordCount=${backfilledWordCount}`);
        }

        // Use backfilled values when available, otherwise fall back to the original snapshot
        const responseWordCount = backfilledWordCount ?? document.wordCount;
        const completedAt = backfilledCompletedAt ?? document.job?.completedAt;
        const responseProcessingTime = document.job?.createdAt && completedAt
          ? new Date(completedAt).getTime() - new Date(document.job.createdAt).getTime()
          : null;

        res.json({
          success: true,
          data: {
            documentId: document.id,
            content: document.documentContent.fullHtml,
            fileName: document.originalName,
            fileSize: document.fileSize,
            wordCount: responseWordCount,
            processingTime: responseProcessingTime,
            contentType: detectedContentType,
          },
        });
        return;
      }

      // Otherwise, convert DOCX to HTML using Pandoc (or mammoth fallback)
      logger.info(`[Validator] Converting document to HTML: ${documentId} (${document.originalName})`);

      const fileBuffer = await citationStorageService.getFileBuffer(
        document.storagePath,
        document.storageType as 'S3' | 'LOCAL'
      );

      // Convert document to HTML with formatting preservation
      // Supports DOCX (via Pandoc) and PDF (via pdf-parse)
      const result = await docxConversionService.convertDocumentToHtml(fileBuffer, document.originalName);

      // Combine styles and content
      const htmlContent = result.styles + result.html;

      // Log conversion info
      if (result.warnings.length > 0) {
        logger.warn(`[Validator] Document conversion warnings for ${documentId}:`, result.warnings);
      }
      logger.info(`[Validator] Conversion complete for ${documentId}: ` +
        `tables=${result.metadata.tableCount}, images=${result.metadata.imageCount}, ` +
        `footnotes=${result.metadata.footnoteCount}, usedPandoc=${result.usedPandoc}`);

      // Extract plain text from HTML for style validation
      const fullText = htmlToPlainText(htmlContent);

      // Cache the HTML content in EditorialDocumentContent table
      await prisma.editorialDocumentContent.upsert({
        where: { documentId },
        create: {
          documentId,
          fullHtml: htmlContent,
          fullText,
          wordCount: result.metadata.wordCount,
        },
        update: {
          fullHtml: htmlContent,
          fullText,
          wordCount: result.metadata.wordCount,
        },
      });

      // Update document stats and mark as PARSED on first conversion
      let conversionCompletedAt: Date | null = null;
      if (document.status === 'UPLOADED') {
        conversionCompletedAt = new Date();
        const txOps: Prisma.PrismaPromise<unknown>[] = [
          prisma.editorialDocument.update({
            where: { id: documentId },
            data: {
              status: 'PARSED',
              wordCount: result.metadata.wordCount,
              updatedAt: conversionCompletedAt,
            },
          }),
        ];
        if (document.jobId) {
          txOps.push(
            prisma.job.update({
              where: { id: document.jobId },
              data: { status: 'COMPLETED', completedAt: conversionCompletedAt },
            }),
          );
        }
        await prisma.$transaction(txOps);
        logger.info(`[Validator] Document ${documentId} marked PARSED, job ${document.jobId} marked COMPLETED`);
      }

      // Lazy backfill: detect content type for documents converted before this feature.
      // Uses updateMany with conditional WHERE (idempotent, safe in GET handler).
      if (detectedContentType === 'UNKNOWN') {
        const detection = contentTypeDetector.detectContentType(fullText, htmlContent);
        if (detection.contentType !== 'UNKNOWN') {
          detectedContentType = detection.contentType;
          await prisma.editorialDocument.updateMany({
            where: { id: documentId, contentType: 'UNKNOWN' },
            data: { contentType: detection.contentType },
          });
          logger.debug(`[ContentType] Detected ${detection.contentType} for ${documentId} (signals: ${detection.signals.join(', ')})`);
        }
      }

      const effectiveCompletedAt = conversionCompletedAt ?? document.job?.completedAt;
      res.json({
        success: true,
        data: {
          documentId: document.id,
          content: htmlContent,
          fileName: document.originalName,
          fileSize: document.fileSize,
          wordCount: result.metadata.wordCount,
          processingTime: document.job?.createdAt && effectiveCompletedAt
            ? new Date(effectiveCompletedAt).getTime() - new Date(document.job.createdAt).getTime()
            : null,
          conversionWarnings: result.warnings,
          metadata: result.metadata,
          contentType: detectedContentType,
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to get document content:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents/:documentId/file
   * Get raw file (PDF or DOCX) for viewing/download
   */
  async getDocumentFile(
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
          storagePath: true,
          storageType: true,
          originalName: true,
          mimeType: true,
        },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      logger.info(`[Validator] Serving file: ${documentId} (${document.originalName})`);

      const fileBuffer = await citationStorageService.getFileBuffer(
        document.storagePath,
        document.storageType as 'S3' | 'LOCAL'
      );

      // Set appropriate headers
      res.setHeader('Content-Type', document.mimeType);
      res.setHeader('Content-Length', fileBuffer.length);
      const safeName = document.originalName.replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(document.originalName)}`);

      // Send the file
      res.send(fileBuffer);
    } catch (error) {
      logger.error('[Validator] Failed to get document file:', error);
      next(error);
    }
  }

  /**
   * PUT /api/v1/validator/documents/:documentId/content
   * Save document content (HTML) and create a version snapshot
   */
  async saveDocumentContent(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
      const { documentId } = req.params;
      const { content, createVersion = true } = req.body;

      if (!content || typeof content !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_CONTENT', message: 'Content is required and must be a string' },
        });
        return;
      }

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          documentContent: {
            select: { fullHtml: true },
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

      // Get previous content for change detection
      const previousContent = document.documentContent?.fullHtml || '';

      // Extract plain text from HTML for style validation
      const fullText = htmlToPlainText(content);

      const wordCount = fullText.split(/\s+/).filter(Boolean).length;

      const updated = await prisma.editorialDocumentContent.upsert({
        where: { documentId },
        create: {
          documentId,
          fullHtml: content,
          fullText,
          wordCount,
        },
        update: {
          fullHtml: content,
          fullText,
          wordCount,
          updatedAt: new Date(),
        },
      });

      // Also update the parent document's updatedAt timestamp
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { updatedAt: new Date() },
      });

      // Create a version snapshot if content changed and createVersion is true
      let versionNumber: number | null = null;
      if (createVersion && content !== previousContent) {
        // Use transaction with advisory lock to prevent race conditions
        const lockKey = Buffer.from(documentId).reduce((a, b) => a + b, 0);
        versionNumber = await prisma.$transaction(async (tx) => {
          // Acquire advisory lock scoped to this document
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

          // Get the latest version number
          const latestVersion = await tx.documentVersion.findFirst({
            where: { documentId },
            orderBy: { version: 'desc' },
            select: { version: true },
          });

          const newVersion = (latestVersion?.version || 0) + 1;

          // Create the version snapshot
          await tx.documentVersion.create({
            data: {
              documentId,
              version: newVersion,
              createdBy: userId,
              changeLog: [{
                timestamp: new Date().toISOString(),
                action: 'content_save',
                wordCount,
              }],
              snapshot: {
                content,
                wordCount,
                savedAt: new Date().toISOString(),
              },
              snapshotType: 'full',
            },
          });

          return newVersion;
        });

        logger.info(`[Validator] Created version ${versionNumber} for document: ${documentId}`);
      }

      logger.info(`[Validator] Saved document content: ${documentId}, wordCount: ${wordCount}`);

      res.json({
        success: true,
        data: {
          documentId,
          savedAt: updated.updatedAt,
          wordCount,
          version: versionNumber,
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to save document content:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents/:documentId/versions
   * Get version history for a document
   */
  async getDocumentVersions(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const { documentId } = req.params;

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

      const versions = await prisma.documentVersion.findMany({
        where: { documentId },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          createdAt: true,
          createdBy: true,
          changeLog: true,
          snapshotType: true,
        },
      });

      res.json({
        success: true,
        data: {
          documentId,
          versions,
          total: versions.length,
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to get document versions:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents/:documentId/versions/:versionId
   * Get a specific version's content
   */
  async getDocumentVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const { documentId, versionId } = req.params;

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, originalName: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const version = await prisma.documentVersion.findFirst({
        where: { id: versionId, documentId },
      });

      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          documentId,
          versionId: version.id,
          version: version.version,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          changeLog: version.changeLog,
          snapshot: version.snapshot,
          snapshotType: version.snapshotType,
          fileName: document.originalName,
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to get document version:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/validator/documents/:documentId/versions/:versionId/restore
   * Restore document to a specific version
   */
  async restoreDocumentVersion(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
      const { documentId, versionId } = req.params;

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

      const version = await prisma.documentVersion.findFirst({
        where: { id: versionId, documentId },
      });

      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
        return;
      }

      // Extract content from snapshot
      const snapshot = version.snapshot as { content?: string; wordCount?: number };
      if (!snapshot?.content) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_SNAPSHOT', message: 'Version snapshot does not contain content' },
        });
        return;
      }

      const content = snapshot.content;
      const wordCount = snapshot.wordCount || content.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length;

      // Use transaction with advisory lock to prevent race conditions
      const lockKey = Buffer.from(documentId).reduce((a, b) => a + b, 0);
      const newVersionNumber = await prisma.$transaction(async (tx) => {
        // Acquire advisory lock scoped to this document
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

        // Update current content
        await tx.editorialDocumentContent.upsert({
          where: { documentId },
          create: {
            documentId,
            fullHtml: content,
            wordCount,
          },
          update: {
            fullHtml: content,
            wordCount,
            updatedAt: new Date(),
          },
        });

        // Get the latest version number for new restore version
        const latestVersion = await tx.documentVersion.findFirst({
          where: { documentId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });

        const newVersion = (latestVersion?.version || 0) + 1;

        // Create a new version to mark the restore
        await tx.documentVersion.create({
          data: {
            documentId,
            version: newVersion,
            createdBy: userId,
            changeLog: [{
              timestamp: new Date().toISOString(),
              action: 'restore',
              restoredFrom: version.version,
              restoredVersionId: versionId,
            }],
            snapshot: {
              content,
              wordCount,
              savedAt: new Date().toISOString(),
              restoredFromVersion: version.version,
            },
            snapshotType: 'full',
          },
        });

        // Update document timestamp
        await tx.editorialDocument.update({
          where: { id: documentId },
          data: { updatedAt: new Date() },
        });

        return newVersion;
      });

      logger.info(`[Validator] Restored document ${documentId} to version ${version.version}, created version ${newVersionNumber}`);

      res.json({
        success: true,
        data: {
          documentId,
          restoredFromVersion: version.version,
          newVersion: newVersionNumber,
          wordCount,
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to restore document version:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/validator/documents/:documentId/export
   * Export document as DOCX with all formatting preserved
   */
  async exportDocument(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const { documentId } = req.params;

      // Get document with content
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: {
          id: true,
          originalName: true,
          storagePath: true,
          storageType: true,
          documentContent: {
            select: {
              fullHtml: true,
            },
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

      if (!document.documentContent?.fullHtml) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_CONTENT', message: 'Document has no content to export' },
        });
        return;
      }

      const rawMode = (req.query.mode as string) || 'clean';
      const exportMode: 'clean' | 'tracked' = rawMode === 'tracked' ? 'tracked' : 'clean';
      logger.info(`[Validator] Exporting document ${documentId} to DOCX (mode: ${exportMode})`);

      let docxBuffer: Buffer;
      const titleBase = document.originalName.replace(/\.docx$/i, '');
      const currentHtml = document.documentContent.fullHtml;

      // Both modes use the original DOCX to preserve formatting.
      // 'clean'   — plain text replacement (accept all changes)
      // 'tracked' — Word revision marks (<w:del>/<w:ins>) that can be accepted/rejected in Word
      if (document.storagePath && document.storageType) {
        try {
          const originalBuffer = await citationStorageService.getFileBuffer(
            document.storagePath,
            document.storageType as 'S3' | 'LOCAL'
          );
          if (originalBuffer) {
            docxBuffer = await docxConversionService.exportWithTrackChanges(
              originalBuffer,
              currentHtml,
              { title: titleBase, mode: exportMode }
            );
            logger.info(`[Validator] Exported ${exportMode} using original DOCX for ${documentId}`);
          } else {
            docxBuffer = await docxConversionService.convertHtmlToDocx(currentHtml, { title: titleBase });
          }
        } catch (err) {
          logger.warn(`[Validator] Original DOCX export failed, falling back to Pandoc:`, err);
          docxBuffer = await docxConversionService.convertHtmlToDocx(currentHtml, { title: titleBase });
        }
      } else {
        docxBuffer = await docxConversionService.convertHtmlToDocx(currentHtml, { title: titleBase });
      }

      // Generate filename
      const suffix = exportMode === 'tracked' ? '_tracked' : '_edited';
      const exportName = document.originalName.replace(/\.docx$/i, '') + suffix + '.docx';

      // Send the DOCX file
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const safeName = exportName.replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(exportName)}`);
      res.setHeader('Content-Length', docxBuffer.length);
      res.send(docxBuffer);

      logger.info(`[Validator] Exported document ${documentId} as ${exportName}`);
    } catch (error) {
      logger.error('[Validator] Failed to export document:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/validator/documents/:documentId/clear-cache
   * Clear cached HTML content to force re-conversion from original DOCX
   */
  async clearContentCache(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { tenantId } = req.user!;
      const { documentId } = req.params;

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

      // Delete cached content
      await prisma.editorialDocumentContent.deleteMany({
        where: { documentId },
      });

      logger.info(`[Validator] Cleared content cache for document: ${documentId}`);

      res.json({
        success: true,
        data: {
          documentId,
          message: 'Content cache cleared. Document will be re-converted on next load.',
        },
      });
    } catch (error) {
      logger.error('[Validator] Failed to clear content cache:', error);
      next(error);
    }
  }
}

export const validatorController = new ValidatorController();
