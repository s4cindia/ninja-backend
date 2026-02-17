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
import * as path from 'path';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiCitationDetectorService } from '../../services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../services/citation/docx-processor.service';
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { getCitationQueue, areQueuesAvailable, JOB_TYPES } from '../../queues';

const ALLOWED_MIMES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** Type guard to validate authenticated user exists on request */
function isAuthenticated(req: Request): req is Request & { user: { tenantId: string; id: string } } {
  return req.user !== undefined &&
         typeof req.user.tenantId === 'string' &&
         typeof req.user.id === 'string';
}

export class CitationUploadController {
  /**
   * POST /api/v1/citation/upload
   * Upload and analyze DOCX document
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
      if (!isAuthenticated(req)) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
        });
        return;
      }
      const { documentId } = req.params;
      const { tenantId } = req.user;

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

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: { include: { reference: true } },
          job: true,
          documentContent: true
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

          // Create links for numeric citations
          const linkData: { citationId: string; referenceListEntryId: string }[] = [];
          for (const citation of createdCitations) {
            if (citation.citationType === 'NUMERIC') {
              // Extract all numbers from the citation (handles [1], [1, 2], [1-3], etc.)
              const nums = citation.rawText.match(/\d+/g);
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
