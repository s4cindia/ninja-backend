/**
 * Citation Upload Controller
 * Handles document upload, analysis, and job status
 *
 * Endpoints:
 * - POST /upload - Upload DOCX and start analysis
 * - GET /job/:jobId/status - Get job status for polling
 * - GET /document/:documentId/analysis - Get analysis results
 * - POST /document/:documentId/reanalyze - Re-run analysis
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiCitationDetectorService } from '../../services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../services/citation/docx-processor.service';
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { getCitationQueue, areQueuesAvailable, JOB_TYPES } from '../../queues';

const ALLOWED_MIMES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export class CitationUploadController {
  /**
   * POST /api/v1/citation/upload
   * Upload and analyze DOCX document
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
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

      // Extract filename from storage path for database record
      const storedFileName = storageResult.storagePath.split('/').pop() || file.originalname;

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
      const useAsyncProcessing = areQueuesAvailable();

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
              filename: file.originalname,
              statistics: stats,
              message: 'Document uploaded. Analysis is processing in the background.',
            },
          });
          return;
        }
      }

      // Fallback: Run synchronously if queue not available
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
   */
  async reanalyze(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

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

      // Clear existing data
      await prisma.citation.deleteMany({ where: { documentId } });
      await prisma.referenceListEntry.deleteMany({ where: { documentId } });
      await prisma.citationChange.deleteMany({ where: { documentId } });

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
   * GET /api/v1/citation-management/job/:jobId/status
   * Get job status for polling (used with async processing)
   */
  async getJobStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const { tenantId } = req.user!;

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
   */
  async getAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: { include: { reference: true } },
          job: true
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get reference list entries with citation links
      const references = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' },
        include: { citationLinks: true }
      });

      // Get reference style conversions
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
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

      // Format citations for response
      const formattedCitations = document.citations.map(c => ({
        id: c.id,
        rawText: c.rawText,
        type: c.citationType,
        position: {
          paragraph: c.paragraphIndex,
          startOffset: c.startOffset,
          endOffset: c.endOffset
        },
        referenceId: c.referenceId,
        confidence: c.confidence
      }));

      res.json({
        success: true,
        data: {
          documentId: document.id,
          filename: document.originalName,
          status: document.status,
          detectedStyle: document.referenceListStyle,
          statistics: {
            wordCount: document.wordCount,
            pageCount: document.pageCount,
            citationsFound: document.citations.length,
            referencesFound: references.length
          },
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
      const citationData = analysis.inTextCitations.map(citation => ({
        documentId,
        rawText: citation.text || '',
        citationType: citation.type === 'numeric' ? 'NUMERIC' as const : 'PARENTHETICAL' as const,
        startOffset: citation.position?.startChar || 0,
        endOffset: citation.position?.endChar || 0,
        paragraphIndex: citation.position?.paragraph || 0,
        confidence: 0.8
      }));

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
}

export const citationUploadController = new CitationUploadController();
