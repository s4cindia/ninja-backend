/**
 * Citation Upload Controller
 * Handles document upload, analysis, and job status
 *
 * Endpoints:
 * - POST /presign-upload - Get presigned S3 URL for DOCX upload
 * - POST /confirm-upload - Confirm upload and start analysis
 * - POST /upload - Legacy: Upload DOCX and start analysis (deprecated, use presigned URLs)
 * - GET /job/:jobId/status - Get job status for polling
 * - GET /document/:documentId/analysis - Get analysis results
 * - POST /document/:documentId/reanalyze - Re-run analysis
 */

import { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { nanoid } from 'nanoid';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { s3Service } from '../../services/s3.service';
import { aiCitationDetectorService } from '../../services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../services/citation/docx-processor.service';
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { getCitationQueue, areQueuesAvailable, JOB_TYPES } from '../../queues';
import { normalizeSuperscripts } from '../../utils/unicode';
import { claudeService } from '../../services/ai/claude.service';

const ALLOWED_MIMES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** Type guard to validate authenticated user exists on request */
function isAuthenticated(req: Request): req is Request & { user: { tenantId: string; id: string } } {
  return req.user !== undefined &&
         typeof req.user.tenantId === 'string' &&
         typeof req.user.id === 'string';
}

/**
 * Match author-year citation text to reference entries
 * Handles: "(Smith, 2020)", "(Brown et al., 2021)", "(Smith & Jones, 2020)"
 * Also handles multiple citations: "(Brown et al., 2020; Bommasani et al., 2021)"
 */
function matchAuthorYearCitation(
  citationText: string,
  references: Array<{ id: string; authors: string[]; year: string | null }>
): Array<{ id: string }> {
  const matches: Array<{ id: string }> = [];

  // Remove parentheses and split by semicolon for multiple citations
  const innerText = citationText.replace(/^\(|\)$/g, '').trim();
  const parts = innerText.split(/\s*;\s*/);

  for (const part of parts) {
    // Extract author name(s) and year from the citation part
    // Patterns: "Smith, 2020", "Smith & Jones, 2020", "Smith et al., 2020"
    const authorYearPatterns = [
      // "Brown et al., 2020" or "Brown et al. 2020"
      /^([A-Z][a-zA-Z'-]+)\s+et\s+al\.?,?\s*(\d{4})/i,
      // "Smith & Jones, 2020"
      /^([A-Z][a-zA-Z'-]+)\s*(?:&|and)\s*[A-Z][a-zA-Z'-]+,?\s*(\d{4})/i,
      // "Smith, 2020"
      /^([A-Z][a-zA-Z'-]+),?\s*(\d{4})/i,
    ];

    for (const pattern of authorYearPatterns) {
      const match = part.match(pattern);
      if (match) {
        const authorName = match[1].toLowerCase();
        const year = match[2];

        // Find matching reference by author and year
        const matchedRef = references.find(ref => {
          if (!ref.authors || ref.authors.length === 0) return false;
          if (ref.year !== year) return false;

          // Check if any author's last name matches
          const hasMatchingAuthor = ref.authors.some(author => {
            // Extract last name (first part before comma, or first word)
            const lastName = author.split(/[,\s]/)[0].toLowerCase();
            return lastName === authorName || lastName.includes(authorName) || authorName.includes(lastName);
          });

          return hasMatchingAuthor;
        });

        if (matchedRef && !matches.some(m => m.id === matchedRef.id)) {
          matches.push({ id: matchedRef.id });
        }
        break; // Found a pattern match, move to next part
      }
    }
  }

  return matches;
}

export class CitationUploadController {
  /**
   * POST /api/v1/citation-management/presign-upload
   * Get presigned S3 URL for DOCX upload
   *
   * This is the preferred upload method per PRESIGNED_S3_UPLOAD_DESIGN.md:
   * - Avoids CloudFront WAF blocking multipart uploads
   * - Prevents ECS memory exhaustion from in-memory file buffers
   */
  async presignUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }

      const { tenantId } = req.user;
      const { fileName, fileSize } = req.body;

      if (!fileName || typeof fileName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FILENAME', message: 'fileName is required' }
        });
        return;
      }

      // Validate file extension
      const fileExt = fileName.toLowerCase().split('.').pop();
      if (fileExt !== 'docx') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Only DOCX files are allowed' }
        });
        return;
      }

      // Validate file size if provided
      if (fileSize && fileSize > MAX_FILE_SIZE) {
        res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` }
        });
        return;
      }

      // Check if S3 is configured
      if (!s3Service.isConfigured()) {
        logger.warn('[Citation Upload] S3 not configured, presign unavailable', s3Service.getConfigStatus());
        res.status(503).json({
          success: false,
          error: { code: 'S3_NOT_CONFIGURED', message: 'S3 storage is not configured. Contact administrator.' }
        });
        return;
      }

      const contentType = ALLOWED_MIMES[0];

      // Get presigned URL from S3
      let result;
      try {
        result = await s3Service.getPresignedUploadUrl(
          tenantId,
          fileName,
          contentType,
          3600 // 1 hour expiry
        );
      } catch (s3Error: unknown) {
        // Log detailed S3 error for debugging
        const errorMessage = s3Error instanceof Error ? s3Error.message : String(s3Error);
        const errorName = s3Error instanceof Error ? s3Error.name : 'UnknownError';
        logger.error('[Citation Upload] S3 presign failed:', {
          error: errorMessage,
          errorName,
          configStatus: s3Service.getConfigStatus(),
        });

        // Return specific error code for S3 credential/permission issues
        if (errorName === 'CredentialsProviderError' || errorMessage.includes('credentials')) {
          res.status(503).json({
            success: false,
            error: {
              code: 'S3_CREDENTIALS_ERROR',
              message: 'S3 credentials not configured. Contact administrator.'
            }
          });
          return;
        }

        if (errorName === 'AccessDenied' || errorMessage.includes('Access Denied')) {
          res.status(503).json({
            success: false,
            error: {
              code: 'S3_ACCESS_DENIED',
              message: 'S3 access denied. Check IAM permissions.'
            }
          });
          return;
        }

        // Generic S3 error
        res.status(503).json({
          success: false,
          error: {
            code: 'S3_ERROR',
            message: 'S3 service error. Please try again later.'
          }
        });
        return;
      }

      // Create a pending file record
      const file = await prisma.file.create({
        data: {
          id: nanoid(),
          tenantId,
          filename: fileName,
          originalName: fileName,
          mimeType: contentType,
          size: fileSize || 0,
          path: result.fileKey,
          status: 'PENDING_UPLOAD',
          storagePath: result.fileKey,
          storageType: 'S3',
          updatedAt: new Date(),
        },
      });

      logger.info(`[Citation Upload] Generated presigned URL for ${fileName}, fileId=${file.id}`);

      res.json({
        success: true,
        data: {
          uploadUrl: result.uploadUrl,
          fileKey: result.fileKey,
          fileId: file.id,
          expiresIn: result.expiresIn,
        },
      });
    } catch (error) {
      logger.error('[Citation Upload] Presign failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/confirm-upload
   * Confirm S3 upload completed and start analysis
   */
  async confirmUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }

      const { tenantId, id: userId } = req.user;
      const { fileKey, fileName } = req.body;

      if (!fileKey || typeof fileKey !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FILE_KEY', message: 'fileKey is required' }
        });
        return;
      }

      if (!fileName || typeof fileName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FILENAME', message: 'fileName is required' }
        });
        return;
      }

      logger.info(`[Citation Upload] Confirming upload: ${fileKey}`);

      // Verify S3 is configured
      if (!s3Service.isConfigured()) {
        logger.error('[Citation Upload] S3 bucket not configured');
        res.status(503).json({
          success: false,
          error: { code: 'S3_NOT_CONFIGURED', message: 'Storage service not configured. Contact administrator.' }
        });
        return;
      }

      // Download file from S3 to process
      let fileBuffer: Buffer;
      try {
        fileBuffer = await s3Service.getFileBuffer(fileKey);
      } catch (s3Error: unknown) {
        const errorName = s3Error instanceof Error ? s3Error.name : 'UnknownError';
        const errorMessage = s3Error instanceof Error ? s3Error.message : String(s3Error);
        logger.error(`[Citation Upload] Failed to retrieve file from S3: ${fileKey}`, { errorName, errorMessage, s3Error });

        // Return specific error codes based on S3 error type
        const lowerMessage = errorMessage.toLowerCase();
        if (errorName === 'NoSuchKey' || errorMessage.includes('NoSuchKey') || lowerMessage.includes('not found') || lowerMessage.includes('notfound')) {
          res.status(400).json({
            success: false,
            error: { code: 'FILE_NOT_FOUND', message: 'File not found in S3. Upload may have failed.' }
          });
          return;
        }

        if (errorName === 'AccessDenied' || errorMessage.includes('AccessDenied')) {
          res.status(503).json({
            success: false,
            error: { code: 'S3_ACCESS_DENIED', message: 'Storage access denied. Contact administrator.' }
          });
          return;
        }

        if (errorName === 'CredentialsProviderError' || errorMessage.includes('credentials')) {
          res.status(503).json({
            success: false,
            error: { code: 'S3_CREDENTIALS_ERROR', message: 'Storage credentials not configured. Contact administrator.' }
          });
          return;
        }

        res.status(500).json({
          success: false,
          error: { code: 'S3_ERROR', message: 'Failed to retrieve file from storage. Please try again.' }
        });
        return;
      }

      // Security: Validate ZIP magic bytes (DOCX is a ZIP file)
      if (fileBuffer.length < 4 || fileBuffer.readUInt32LE(0) !== 0x04034B50) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_STRUCTURE', message: 'Invalid DOCX file structure' }
        });
        return;
      }

      // Validate DOCX content structure
      const validation = await docxProcessorService.validateDOCX(fileBuffer);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCX', message: validation.error }
        });
        return;
      }

      // Extract text and statistics
      const content = await docxProcessorService.extractText(fileBuffer);
      const stats = await docxProcessorService.getStatistics(fileBuffer);

      // Create job
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION',
          status: 'PROCESSING',
          input: {
            filename: fileName,
            fileSize: fileBuffer.length,
            fileKey,
            mimeType: ALLOWED_MIMES[0],
          },
          output: {},
          priority: 1
        }
      });

      // Extract filename from storage path for database record (cross-platform)
      const storedFileName = path.basename(fileKey) || fileName;

      // Create document record with content in separate table for performance
      const document = await prisma.editorialDocument.create({
        data: {
          tenantId,
          jobId: job.id,
          originalName: fileName,
          fileName: storedFileName,
          mimeType: ALLOWED_MIMES[0],
          fileSize: fileBuffer.length,
          storagePath: fileKey,
          storageType: 'S3',
          wordCount: stats.wordCount,
          pageCount: stats.pageCount,
          status: 'QUEUED',
          documentContent: {
            create: {
              fullText: content.text,
              fullHtml: content.html,
              wordCount: stats.wordCount,
              pageCount: stats.pageCount,
            }
          }
        }
      });

      // Update file record status
      await prisma.file.updateMany({
        where: { storagePath: fileKey, tenantId },
        data: { status: 'UPLOADED' }
      });

      // Check if async processing is available (Redis configured)
      // Can be disabled via CITATION_FORCE_SYNC=true for debugging
      const forceSync = process.env.CITATION_FORCE_SYNC === 'true';
      const useAsyncProcessing = !forceSync && areQueuesAvailable();

      logger.info(`[Citation Upload] Processing mode: ${useAsyncProcessing ? 'ASYNC (queue)' : 'SYNC (inline)'}, forceSync=${forceSync}`);

      if (useAsyncProcessing) {
        const citationQueue = getCitationQueue();
        if (citationQueue) {
          await citationQueue.add(
            `citation-${document.id}`,
            {
              type: JOB_TYPES.CITATION_DETECTION,
              tenantId,
              userId,
              options: { documentId: document.id },
            },
            { jobId: job.id, priority: 1 }
          );

          await prisma.job.update({
            where: { id: job.id },
            data: { status: 'QUEUED' },
          });

          logger.info(`[Citation Upload] Queued analysis job for ${document.id}`);

          res.json({
            success: true,
            data: {
              documentId: document.id,
              jobId: job.id,
              status: 'QUEUED',
              filename: fileName,
              statistics: stats,
              message: 'Document uploaded. Analysis is processing in the background.',
            },
          });
          return;
        }
      }

      // Fallback: Run synchronously if queue not available or forceSync=true
      logger.info(`[Citation Upload] Running synchronous analysis for ${document.id}`);

      await prisma.editorialDocument.update({
        where: { id: document.id },
        data: { status: 'ANALYZING' },
      });

      await this.analyzeDocument(document.id, content.text);

      // Get final results
      const finalDoc = await prisma.editorialDocument.findUnique({
        where: { id: document.id },
        include: { citations: true }
      });
      const finalRefs = await prisma.referenceListEntry.count({
        where: { documentId: document.id }
      });

      // Update job status
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });

      res.json({
        success: true,
        data: {
          documentId: document.id,
          status: 'COMPLETED',
          filename: fileName,
          statistics: {
            ...stats,
            citationsFound: finalDoc?.citations?.length || 0,
            referencesFound: finalRefs
          }
        }
      });
    } catch (error) {
      logger.error('[Citation Upload] Confirm upload failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/upload
   * Upload and analyze DOCX document
   *
   * @deprecated Use presignUpload + confirmUpload for production.
   * In-memory uploads can exhaust ECS memory and are blocked by CloudFront WAF.
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { tenantId, id: userId } = req.user;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' }
        });
        return;
      }

      // Security: Strict file validation
      if (!ALLOWED_MIMES.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Only DOCX files are allowed' }
        });
        return;
      }

      const fileExt = file.originalname.toLowerCase().split('.').pop();
      if (fileExt !== 'docx') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_EXTENSION', message: 'File must have .docx extension' }
        });
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds 50MB limit' }
        });
        return;
      }

      // Validate ZIP magic bytes (DOCX is a ZIP file)
      if (file.buffer.length < 4 || file.buffer.readUInt32LE(0) !== 0x04034B50) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_STRUCTURE', message: 'Invalid DOCX file structure' }
        });
        return;
      }

      logger.info(`[Citation Upload] Processing: ${file.originalname}`);

      // Validate DOCX content structure
      const validation = await docxProcessorService.validateDOCX(file.buffer);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCX', message: validation.error }
        });
        return;
      }

      // Extract text and statistics
      const content = await docxProcessorService.extractText(file.buffer);
      const stats = await docxProcessorService.getStatistics(file.buffer);

      // Create job
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION',
          status: 'PROCESSING',
          input: {
            filename: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype
          },
          output: {},
          priority: 1
        }
      });

      // Save original DOCX file to storage (S3 or local fallback)
      const storageResult = await citationStorageService.uploadFile(
        tenantId,
        file.originalname,
        file.buffer,
        file.mimetype
      );

      logger.info(`[Citation Upload] Saved DOCX to ${storageResult.storageType}: ${storageResult.storagePath}`);

      // Extract filename from storage path for database record (cross-platform)
      const storedFileName = path.basename(storageResult.storagePath) || file.originalname;

      // Create document record with content in separate table for performance
      const document = await prisma.editorialDocument.create({
        data: {
          tenantId,
          jobId: job.id,
          originalName: file.originalname,
          fileName: storedFileName,
          mimeType: file.mimetype,
          fileSize: file.size,
          storagePath: storageResult.storagePath,
          storageType: storageResult.storageType,
          wordCount: stats.wordCount,
          pageCount: stats.pageCount,
          status: 'QUEUED',
          // Create content in separate table
          documentContent: {
            create: {
              fullText: content.text,
              fullHtml: content.html,
              wordCount: stats.wordCount,
              pageCount: stats.pageCount,
            }
          }
        }
      });

      // Check if async processing is available (Redis configured)
      // Can be disabled via CITATION_FORCE_SYNC=true for debugging
      const forceSyncUpload = process.env.CITATION_FORCE_SYNC === 'true';
      const useAsyncProcessingUpload = !forceSyncUpload && areQueuesAvailable();

      logger.info(`[Citation Upload] Processing mode: ${useAsyncProcessingUpload ? 'ASYNC (queue)' : 'SYNC (inline)'}, forceSync=${forceSyncUpload}`);

      if (useAsyncProcessingUpload) {
        const citationQueue = getCitationQueue();
        if (citationQueue) {
          await citationQueue.add(
            `citation-${document.id}`,
            {
              type: JOB_TYPES.CITATION_DETECTION,
              tenantId,
              userId,
              options: { documentId: document.id },
            },
            { jobId: job.id, priority: 1 }
          );

          await prisma.job.update({
            where: { id: job.id },
            data: { status: 'QUEUED' },
          });

          logger.info(`[Citation Upload] Queued analysis job for ${document.id}`);

          res.json({
            success: true,
            data: {
              documentId: document.id,
              jobId: job.id,
              status: 'QUEUED',
              filename: file.originalname,
              statistics: stats,
              message: 'Document uploaded. Analysis is processing in the background.',
            },
          });
          return;
        }
      }

      // Fallback: Run synchronously if queue not available or forceSync=true
      logger.info(`[Citation Upload] Running synchronous analysis for ${document.id}`);

      await prisma.editorialDocument.update({
        where: { id: document.id },
        data: { status: 'ANALYZING' },
      });

      await this.analyzeDocument(document.id, content.text);

      // Get final results
      const finalDoc = await prisma.editorialDocument.findUnique({
        where: { id: document.id },
        include: { citations: true }
      });
      const finalRefs = await prisma.referenceListEntry.count({
        where: { documentId: document.id }
      });

      // Update job status
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });

      res.json({
        success: true,
        data: {
          documentId: document.id,
          status: 'COMPLETED',
          filename: file.originalname,
          statistics: {
            ...stats,
            citationsFound: finalDoc?.citations?.length || 0,
            referencesFound: finalRefs
          }
        }
      });
    } catch (error) {
      logger.error('[Citation Upload] Upload failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/reanalyze
   * Re-run analysis on existing document
   *
   * AUDIT: Archives existing data before re-analysis to preserve audit trail.
   * Previous citations/references are captured in a REANALYSIS_ARCHIVE change record.
   */
  async reanalyze(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { documentId } = req.params;
      const { tenantId, id: userId } = req.user;

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: { documentContent: true }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Archive existing data before deletion for audit trail
      await this.archiveBeforeReanalysis(documentId, userId);

      // Clear existing citations and references (CitationChange records preserved for audit)
      await prisma.citation.deleteMany({ where: { documentId } });
      await prisma.referenceListEntry.deleteMany({ where: { documentId } });

      // Re-analyze
      await this.analyzeDocument(documentId, document.documentContent?.fullText || '');

      const citationCount = await prisma.citation.count({ where: { documentId } });
      const refCount = await prisma.referenceListEntry.count({ where: { documentId } });

      res.json({
        success: true,
        data: {
          documentId,
          citationsFound: citationCount,
          referencesFound: refCount,
          message: 'Document re-analyzed with auto-resequencing'
        }
      });
    } catch (error) {
      logger.error('[Citation Upload] Reanalyze failed:', error);
      next(error);
    }
  }

  /**
   * Archive existing citations and references before re-analysis.
   * Creates a REANALYSIS_ARCHIVE change record with the previous state
   * and marks existing change records as superseded.
   */
  private async archiveBeforeReanalysis(documentId: string, userId: string): Promise<void> {
    // Fetch existing data to archive
    const [existingCitations, existingReferences, existingChanges] = await Promise.all([
      prisma.citation.findMany({
        where: { documentId },
        select: {
          id: true,
          rawText: true,
          citationType: true,
          detectedStyle: true,
          startOffset: true,
          endOffset: true,
          confidence: true,
        }
      }),
      prisma.referenceListEntry.findMany({
        where: { documentId },
        select: {
          id: true,
          sortKey: true,
          title: true,
          authors: true,
          year: true,
          formattedApa: true,
        }
      }),
      prisma.citationChange.count({
        where: { documentId, isReverted: false }
      })
    ]);

    // Only create archive if there's data to archive
    if (existingCitations.length > 0 || existingReferences.length > 0) {
      const archiveSnapshot = {
        archivedAt: new Date().toISOString(),
        reason: 'REANALYSIS',
        previousChangeCount: existingChanges,
        citations: existingCitations,
        references: existingReferences,
      };

      // Create archive record capturing the pre-reanalysis state
      await prisma.citationChange.create({
        data: {
          documentId,
          changeType: 'REANALYSIS_ARCHIVE',
          beforeText: JSON.stringify(archiveSnapshot),
          afterText: '{}', // Will be populated by new analysis
          appliedBy: userId,
        }
      });

      // Mark existing change records as superseded (part of old analysis)
      // Using isReverted to indicate they belong to a previous analysis version
      await prisma.citationChange.updateMany({
        where: {
          documentId,
          changeType: { not: 'REANALYSIS_ARCHIVE' },
          isReverted: false,
        },
        data: {
          isReverted: true,
          revertedAt: new Date(),
        }
      });

      logger.info(`[Citation Upload] Archived ${existingCitations.length} citations and ${existingReferences.length} references before re-analysis`);
    }
  }

  /**
   * GET /api/v1/citation-management/job/:jobId/status
   * Get job status for polling (used with async processing)
   */
  async getJobStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { jobId } = req.params;
      const { tenantId } = req.user;

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
        select: {
          id: true,
          status: true,
          progress: true,
          error: true,
          output: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
        return;
      }

      // Get document info if job is completed
      let documentInfo = null;
      if (job.status === 'COMPLETED') {
        const document = await prisma.editorialDocument.findFirst({
          where: { jobId: job.id },
          select: {
            id: true,
            originalName: true,
            status: true,
            wordCount: true,
            pageCount: true,
          },
        });

        if (document) {
          const [citationCount, referenceCount] = await Promise.all([
            prisma.citation.count({ where: { documentId: document.id } }),
            prisma.referenceListEntry.count({ where: { documentId: document.id } }),
          ]);

          documentInfo = {
            documentId: document.id,
            filename: document.originalName,
            status: document.status,
            statistics: {
              wordCount: document.wordCount,
              pageCount: document.pageCount,
              citationsFound: citationCount,
              referencesFound: referenceCount,
            },
          };
        }
      }

      res.json({
        success: true,
        data: {
          jobId: job.id,
          status: job.status,
          progress: job.progress || 0,
          error: job.error,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          ...(documentInfo && { document: documentInfo }),
        },
      });
    } catch (error) {
      logger.error('[Citation Upload] Get job status failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/analysis
   * Get complete citation analysis results
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   * This flexibility allows the frontend to use either ID for navigation.
   */
  async getAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { documentId } = req.params;
      const { tenantId } = req.user;

      // First try to find by document ID
      let document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: {
            include: {
              reference: true,
              // Include the join table links to ReferenceListEntry
              referenceListEntries: {
                include: { referenceListEntry: true }
              }
            }
          },
          job: true,
          documentContent: true
        }
      });

      // If not found by document ID, try finding by job ID
      // (frontend may navigate using jobId if documentId wasn't available)
      if (!document) {
        document = await prisma.editorialDocument.findFirst({
          where: { jobId: documentId, tenantId },
          include: {
            citations: {
              include: {
                reference: true,
                // Include the join table links to ReferenceListEntry
                referenceListEntries: {
                  include: { referenceListEntry: true }
                }
              }
            },
            job: true,
            documentContent: true
          }
        });
      }

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get reference list entries with citation links
      // Use document.id (the actual document ID) not documentId (which may be a job ID)
      const actualDocumentId = document.id;
      const references = await prisma.referenceListEntry.findMany({
        where: { documentId: actualDocumentId },
        orderBy: { sortKey: 'asc' },
        include: { citationLinks: true }
      });

      // Get reference style conversions
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId: actualDocumentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });

      // Build map of reference ID to converted text
      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      // Format references for response
      const formattedReferences = references.map((ref, index) => ({
        id: ref.id,
        number: index + 1,
        authors: ref.authors,
        year: ref.year,
        title: ref.title,
        journalName: ref.journalName,
        volume: ref.volume,
        issue: ref.issue,
        pages: ref.pages,
        doi: ref.doi,
        url: ref.url,
        publisher: ref.publisher,
        formattedText: refIdToConvertedText.get(ref.id) || ref.formattedApa || null,
        citationCount: ref.citationLinks.length
      }));

      // Build map from reference ID to reference number (1-based index)
      const refIdToNumber = new Map<string, number>();
      for (let i = 0; i < references.length; i++) {
        refIdToNumber.set(references[i].id, i + 1);
      }

      // Format citations for response
      // Include linked reference IDs from the ReferenceListEntryCitation join table
      const formattedCitations = document.citations.map(c => {
        // Get linked reference IDs from the join table
        const linkedRefIds = c.referenceListEntries?.map(link => link.referenceListEntryId) || [];
        // Get linked reference numbers for display
        const linkedRefNumbers = linkedRefIds
          .map(refId => refIdToNumber.get(refId))
          .filter((num): num is number => num !== undefined);

        return {
          id: c.id,
          rawText: c.rawText,
          type: c.citationType,
          position: {
            paragraph: c.paragraphIndex,
            startOffset: c.startOffset,
            endOffset: c.endOffset
          },
          // Use the first linked reference ID from the join table, or fallback to old referenceId
          referenceId: linkedRefIds[0] || c.referenceId || null,
          // referenceNumber for backward compatibility (first linked reference number)
          referenceNumber: linkedRefNumbers[0] || null,
          // Include all linked reference IDs for compound citations like [1, 2] or [3-5]
          linkedReferenceIds: linkedRefIds,
          linkedReferenceNumbers: linkedRefNumbers,
          confidence: c.confidence
        };
      });

      // Count citations with links for debugging
      const citationsWithLinks = formattedCitations.filter(c => c.linkedReferenceIds.length > 0).length;
      logger.info(`[Citation Upload] getAnalysis response: docId=${document.id}, status=${document.status}, style=${document.referenceListStyle}, citationsCount=${formattedCitations.length}, citationsWithLinks=${citationsWithLinks}, refsCount=${references.length}`);

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            filename: document.originalName,
            status: document.status,
            wordCount: document.wordCount,
            pageCount: document.pageCount,
            fullText: document.documentContent?.fullText || '',
            fullHtml: document.documentContent?.fullHtml || '',
            statistics: {
              // Count individual citation numbers, not just records
              // [1, 2] counts as 2, [3-5] counts as 3
              totalCitations: this.countIndividualCitations(document.citations),
              totalReferences: references.length
            }
          },
          detectedStyle: document.referenceListStyle,
          citations: formattedCitations,
          references: formattedReferences
        }
      });
    } catch (error) {
      logger.error('[Citation Upload] Get analysis failed:', error);
      next(error);
    }
  }

  /**
   * Run AI analysis on document text
   * Public method for use by workers and services
   *
   * @param documentId - Document ID to analyze
   * @param documentText - Full text content
   * @param progressCallback - Optional callback for progress updates (0-100)
   */
  async analyzeDocument(
    documentId: string,
    documentText: string,
    progressCallback?: (progress: number, message: string) => Promise<void>
  ): Promise<void> {
    try {
      if (progressCallback) {
        await progressCallback(10, 'Starting AI citation detection');
      }

      const analysis = await aiCitationDetectorService.analyzeDocument(documentText);

      logger.info(`[Citation Upload] AI detected ${analysis.inTextCitations.length} citations, ${analysis.references.length} references`);

      if (progressCallback) {
        await progressCallback(50, 'Storing citations');
      }

      // Store citations using batch insert for efficiency
      // Split semicolon-separated author-year citations into individual records
      const citationData: Array<{
        documentId: string;
        rawText: string;
        citationType: 'NUMERIC' | 'PARENTHETICAL';
        startOffset: number;
        endOffset: number;
        paragraphIndex: number;
        confidence: number;
      }> = [];

      for (const citation of analysis.inTextCitations) {
        const rawText = citation.text || '';
        const isAuthorYear = citation.type === 'author-year';

        // Check for semicolon-separated multiple citations (e.g., "(Brown et al., 2020; Bommasani et al., 2021)")
        // Only split author-year citations - numeric citations like [1, 2] should be kept as-is
        // because the HTML contains the original compound format which needs to be matched for highlighting
        if (isAuthorYear && rawText.includes(';')) {
          // Remove outer parentheses if present
          const innerText = rawText.replace(/^\(|\)$/g, '').trim();
          const parts = innerText.split(/\s*;\s*/);

          // Create separate records for each citation part
          let currentOffset = citation.position?.startChar || 0;
          for (const part of parts) {
            if (part.trim()) {
              citationData.push({
                documentId,
                rawText: part.trim(),
                citationType: 'PARENTHETICAL',
                startOffset: currentOffset,
                endOffset: currentOffset + part.length,
                paragraphIndex: citation.position?.paragraph || 0,
                confidence: 0.8
              });
              currentOffset += part.length + 2; // +2 for "; "
            }
          }
        } else {
          // Store citation as-is (including compound numeric like [1, 2])
          // The frontend will parse and render each number as clickable
          citationData.push({
            documentId,
            rawText,
            citationType: citation.type === 'numeric' ? 'NUMERIC' : 'PARENTHETICAL',
            startOffset: citation.position?.startChar || 0,
            endOffset: citation.position?.endChar || 0,
            paragraphIndex: citation.position?.paragraph || 0,
            confidence: 0.8
          });
        }
      }

      if (citationData.length > 0) {
        await prisma.citation.createMany({ data: citationData });
      }

      if (progressCallback) {
        await progressCallback(75, 'Storing references');
      }

      // Store references using batch insert
      const refData = analysis.references.map((ref, i) => ({
        documentId,
        sortKey: String(i + 1).padStart(4, '0'),
        authors: ref.components?.authors || [],
        year: ref.components?.year || null,
        title: ref.components?.title || 'Untitled',
        sourceType: 'journal' as const,
        journalName: ref.components?.journal || null,
        volume: ref.components?.volume || null,
        issue: ref.components?.issue || null,
        pages: ref.components?.pages || null,
        doi: ref.components?.doi || null,
        url: ref.components?.url || null,
        publisher: ref.components?.publisher || null,
        enrichmentSource: 'ai' as const,
        enrichmentConfidence: 0.8
      }));

      if (refData.length > 0) {
        await prisma.referenceListEntry.createMany({ data: refData });
      }

      // Create citation-reference links for numeric citations
      // This enables ID-based resequencing instead of text matching
      if (citationData.length > 0 && refData.length > 0) {
        try {
          // Fetch created citations and references to get their IDs
          const [createdCitations, createdRefs] = await Promise.all([
            prisma.citation.findMany({
              where: { documentId },
              orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }]
            }),
            prisma.referenceListEntry.findMany({
              where: { documentId },
              orderBy: { sortKey: 'asc' }
            })
          ]);

          // Build reference number to ID map (sortKey "0001" -> refId)
          const refNumToId = new Map<number, string>();
          for (const ref of createdRefs) {
            const num = parseInt(ref.sortKey) || 0;
            refNumToId.set(num, ref.id);
          }

          // Create links for numeric and footnote citations only
          // Skip author-date citations (e.g., "(Smith, 2021)") to avoid linking year as reference number
          const linkData: { citationId: string; referenceListEntryId: string }[] = [];
          for (const citation of createdCitations) {
            // Only process numeric-style citations (NUMERIC, FOOTNOTE, ENDNOTE)
            // Author-date citations would incorrectly match year (2021) as reference number
            if (citation.citationType !== 'NUMERIC' &&
                citation.citationType !== 'FOOTNOTE' &&
                citation.citationType !== 'ENDNOTE') {
              continue;
            }

            // Convert superscript characters to regular digits (¹²³ -> 123)
            const normalizedText = normalizeSuperscripts(citation.rawText);

            // Extract all numbers from the citation (handles [1], [1, 2], [1-3], ¹, ², etc.)
            const nums = normalizedText.match(/\d+/g);
            if (nums) {
              for (const numStr of nums) {
                const num = parseInt(numStr, 10);
                const refId = refNumToId.get(num);
                if (refId) {
                  linkData.push({
                    citationId: citation.id,
                    referenceListEntryId: refId
                  });
                }
              }
            }
          }

          // Also link author-year (PARENTHETICAL) citations by matching author name and year
          for (const citation of createdCitations) {
            if (citation.citationType !== 'PARENTHETICAL') {
              continue;
            }

            // Parse author-year from citation text like "(Smith, 2020)" or "(Brown et al., 2021)"
            // Convert authors from JsonValue to string[] for type safety
            const refsWithAuthors = createdRefs.map(r => ({
              id: r.id,
              authors: Array.isArray(r.authors) ? r.authors as string[] : [],
              year: r.year
            }));
            const authorYearMatches = matchAuthorYearCitation(citation.rawText, refsWithAuthors);
            for (const matchedRef of authorYearMatches) {
              linkData.push({
                citationId: citation.id,
                referenceListEntryId: matchedRef.id
              });
            }
          }

          if (linkData.length > 0) {
            // Use createMany with skipDuplicates to avoid errors on duplicate links
            await prisma.referenceListEntryCitation.createMany({
              data: linkData,
              skipDuplicates: true
            });
            logger.info(`[Citation Upload] Created ${linkData.length} citation-reference links for document ${documentId}`);
          }
        } catch (linkError) {
          // Don't fail the whole upload if link creation fails
          logger.warn(`[Citation Upload] Failed to create citation-reference links: ${linkError}`);
        }
      }

      if (progressCallback) {
        await progressCallback(90, 'Finalizing');
      }

      // Update document status
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: {
          status: 'PARSED',
          referenceListStyle: analysis.detectedStyle || 'Unknown'
        }
      });

      if (progressCallback) {
        await progressCallback(100, 'Analysis complete');
      }
    } catch (error) {
      logger.error(`[Citation Upload] Analysis failed for ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * GET /api/v1/citation-management/jobs/recent
   * Get recent citation jobs for the current user
   */
  async getRecentJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { tenantId, id: userId } = req.user;
      const limit = Math.min(parseInt(req.query.limit as string) || 3, 10);

      const jobs = await prisma.job.findMany({
        where: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION'
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          input: true,
        }
      });

      // Get document info for each job
      const jobsWithDocuments = await Promise.all(
        jobs.map(async (job) => {
          const document = await prisma.editorialDocument.findFirst({
            where: { jobId: job.id },
            select: {
              id: true,
              originalName: true,
              status: true,
            }
          });

          return {
            jobId: job.id,
            documentId: document?.id || null,
            filename: document?.originalName || (job.input as { filename?: string })?.filename || 'Unknown',
            status: job.status,
            createdAt: job.createdAt,
          };
        })
      );

      res.json({
        success: true,
        data: jobsWithDocuments
      });
    } catch (error) {
      logger.error('[Citation Upload] Get recent jobs failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/health
   * Health check for citation AI service (Claude)
   */
  async healthCheck(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      logger.info('[Citation Upload] Health check requested');

      // Check Claude API key validation
      const keyValidation = claudeService.validateApiKey();

      // Check if Claude service is available
      const isAvailable = claudeService.isAvailable();

      // Get full health check from Claude service
      const healthResult = await claudeService.healthCheck();

      res.json({
        success: true,
        data: {
          service: 'citation-ai',
          provider: 'claude',
          isAvailable,
          keyValidation,
          healthCheck: healthResult,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[Citation Upload] Health check failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.json({
        success: false,
        data: {
          service: 'citation-ai',
          provider: 'claude',
          isAvailable: false,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  /**
   * Count individual citation numbers within compound citations
   * e.g., "[1, 2]" counts as 2, "[3-5]" counts as 3
   */
  private countIndividualCitations(citations: Array<{ rawText: string; citationType: string }>): number {
    let total = 0;
    for (const citation of citations) {
      const rawText = citation.rawText || '';

      // For numeric citations, count individual numbers
      if (citation.citationType === 'NUMERIC') {
        const numbers = this.expandNumericRange(rawText);
        total += numbers.length > 0 ? numbers.length : 1;
      } else if (rawText.includes(';')) {
        // Author-year with semicolons: count parts
        const parts = rawText.replace(/^\(|\)$/g, '').split(/\s*;\s*/);
        total += parts.filter(p => p.trim()).length;
      } else {
        total += 1;
      }
    }
    return total;
  }

  /**
   * Expand numeric ranges and comma-separated numbers
   * e.g., "[1, 2, 3]" -> [1, 2, 3], "[1-3]" -> [1, 2, 3]
   */
  private expandNumericRange(text: string): number[] {
    const numbers: number[] = [];
    // Remove brackets/parentheses
    const inner = text.replace(/[\[\]()]/g, '');
    const parts = inner.split(/\s*,\s*/);

    for (const part of parts) {
      const trimmed = part.trim();
      // Check for range like "1-3" or "1–3" (en-dash)
      const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end && i < start + 100; i++) {
          numbers.push(i);
        }
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num)) {
          numbers.push(num);
        }
      }
    }
    return numbers;
  }
}

export const citationUploadController = new CitationUploadController();
