/**
 * Citation Detection Service
 * US-4.1: Detect and extract citations from documents
 */

import { editorialAi, documentParser } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorialDocStatus } from '@prisma/client';
import { s3Service } from '../s3.service';
import { AppError } from '../../utils/app-error';
import { ErrorCodes } from '../../utils/error-codes';
import {
  DetectedCitation,
  DetectionResult,
  DetectionInput,
  mapToCitationType,
  mapToCitationStyle,
  mapToSectionContext,
} from './citation.types';

export class CitationDetectionService {
  /**
   * Detect all citations in a document from S3
   * Main entry point for US-4.1 (S3 mode)
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param fileS3Key - S3 key for the file (optional if presignedUrl provided)
   * @param presignedUrl - Presigned URL to fetch file (optional if fileS3Key provided)
   * @param fileName - Original file name
   * @param fileSize - File size in bytes (optional)
   * @returns Detection result with all found citations
   */
  async detectFromS3(
    tenantId: string,
    userId: string,
    fileS3Key: string | undefined,
    presignedUrl: string | undefined,
    fileName: string,
    fileSize?: number
  ): Promise<DetectionResult> {
    const startTime = Date.now();

    logger.info(
      `[Citation Detection] Starting from S3 for file=${fileName}, s3Key=${fileS3Key || 'N/A'}, presignedUrl=${presignedUrl ? 'provided' : 'N/A'}`
    );

    try {
      // 1. Create Job record first
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION',
          status: 'PROCESSING',
          input: { fileS3Key, presignedUrl, fileName, fileSize, mode: 's3' },
          startedAt: new Date(),
        },
      });
      const jobId = job.id;
      logger.info(`[Citation Detection] Created job ${jobId}`);

      // 2. Fetch file from S3 key or presigned URL
      let fileBuffer: Buffer;
      if (fileS3Key) {
        try {
          fileBuffer = await s3Service.getFileBuffer(fileS3Key);
        } catch (error) {
          logger.error(
            '[Citation Detection] Failed to fetch file from S3',
            error instanceof Error ? error : undefined
          );
          throw AppError.internal(
            'Unable to download file from storage. Please try uploading again.',
            ErrorCodes.FILE_DOWNLOAD_FAILED
          );
        }
      } else if (presignedUrl) {
        const FETCH_TIMEOUT_MS = 10000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const response = await fetch(presignedUrl, { signal: controller.signal });
          if (!response.ok) {
            throw AppError.badRequest(
              `Unable to download file (HTTP ${response.status}). Please try uploading again.`,
              ErrorCodes.FILE_DOWNLOAD_FAILED
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          fileBuffer = Buffer.from(arrayBuffer);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (controller.signal.aborted) {
            throw AppError.badRequest(
              'File download timed out after 10 seconds. Please check your connection and try again.',
              ErrorCodes.FILE_DOWNLOAD_FAILED
            );
          }
          if (fetchError instanceof AppError) {
            throw fetchError;
          }
          logger.error(
            '[Citation Detection] Presigned URL fetch failed',
            fetchError instanceof Error ? fetchError : undefined
          );
          throw AppError.internal(
            'Unable to download file. Please try again.',
            ErrorCodes.FILE_DOWNLOAD_FAILED
          );
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        throw AppError.badRequest(
          'File source not provided. Please upload a file.',
          ErrorCodes.VALIDATION_ERROR
        );
      }
      const actualSize = fileSize ?? fileBuffer.length;
      logger.info(`[Citation Detection] Fetched file: ${actualSize} bytes`);

      // 3. Parse document to extract text
      let parsed;
      try {
        parsed = await documentParser.parse(fileBuffer, fileName);
        logger.info(
          `[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`
        );
      } catch (error) {
        logger.error(
          '[Citation Detection] Document parsing failed',
          error instanceof Error ? error : undefined
        );
        await prisma.job.update({
          where: { id: jobId },
          data: { status: 'FAILED', error: 'Document parsing failed', completedAt: new Date() },
        });
        throw AppError.unprocessable(
          'Unable to parse document. The file may be corrupted or in an unsupported format.',
          ErrorCodes.CITATION_PARSE_FAILED
        );
      }

      // 4. Create or update EditorialDocument record
      const editorialDoc = await this.createEditorialDocument(
        jobId,
        tenantId,
        fileName,
        fileBuffer.length,
        parsed
      );

      // 5. Detect citations using AI
      let extractedCitations;
      try {
        extractedCitations = await editorialAi.detectCitations(parsed.text);
        logger.info(`[Citation Detection] AI found ${extractedCitations.length} citations`);
      } catch (error) {
        logger.error(
          '[Citation Detection] AI detection failed',
          error instanceof Error ? error : undefined
        );
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            error: 'AI citation detection failed',
            completedAt: new Date(),
          },
        });
        throw AppError.internal(
          'Citation detection service is temporarily unavailable. Please try again in a few moments.',
          ErrorCodes.CITATION_DETECTION_FAILED
        );
      }

      // 6. Store citations in database
      const citations = await this.storeCitations(editorialDoc.id, extractedCitations);

      // 7. Update document status
      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      // 8. Update job to COMPLETED with documentId in output
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: { documentId: editorialDoc.id },
        },
      });

      // 9. Build and return result
      const result = this.buildDetectionResult(
        editorialDoc.id,
        jobId,
        citations,
        startTime,
        fileName
      );

      logger.info(
        `[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`
      );
      return result;
    } catch (error) {
      // If it's already an AppError, just rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      // Log unexpected errors
      logger.error(
        '[Citation Detection] Unexpected error',
        error instanceof Error ? error : undefined
      );

      // Return a generic error message for unexpected errors
      throw AppError.internal(
        'An unexpected error occurred during citation detection. Please try again or contact support if the problem persists.',
        ErrorCodes.CITATION_DETECTION_FAILED
      );
    }
  }

  /**
   * Detect citations directly from a buffer (for multipart uploads)
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param fileBuffer - File buffer from multipart upload
   * @param fileName - Original file name
   * @returns Detection result with all found citations
   */
  async detectFromBuffer(
    tenantId: string,
    userId: string,
    fileBuffer: Buffer,
    fileName: string
  ): Promise<DetectionResult> {
    const startTime = Date.now();

    logger.info(
      `[Citation Detection] Starting from buffer for file=${fileName}, size=${fileBuffer.length}`
    );

    try {
      // 1. Create Job record first
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_DETECTION',
          status: 'PROCESSING',
          input: { fileName, fileSize: fileBuffer.length },
        },
      });
      const jobId = job.id;
      logger.info(`[Citation Detection] Created job ${jobId}`);

      // 2. Parse document to extract text
      const parsed = await documentParser.parse(fileBuffer, fileName);
      logger.info(
        `[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`
      );

      // 3. Create or update EditorialDocument record
      const editorialDoc = await this.createEditorialDocument(
        jobId,
        tenantId,
        fileName,
        fileBuffer.length,
        parsed
      );

      // 4. Detect citations using AI
      const extractedCitations = await editorialAi.detectCitations(parsed.text);
      logger.info(`[Citation Detection] AI found ${extractedCitations.length} citations`);

      // 5. Store citations in database
      const citations = await this.storeCitations(editorialDoc.id, extractedCitations);

      // 6. Update document status
      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      // 7. Update job to COMPLETED with documentId in output
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: { documentId: editorialDoc.id },
        },
      });

      // 8. Build and return result
      const result = this.buildDetectionResult(
        editorialDoc.id,
        jobId,
        citations,
        startTime,
        fileName
      );

      logger.info(
        `[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`
      );
      return result;
    } catch (error) {
      logger.error(
        '[Citation Detection] Failed from buffer',
        error instanceof Error ? error : undefined
      );
      throw error;
    }
  }

  /**
   * Get detection results for an existing document
   * @param documentId - Document ID
   * @param tenantId - Optional tenant ID for cross-tenant protection
   */
  async getDetectionResults(
    documentId: string,
    tenantId?: string
  ): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' },
          include: {
            primaryComponent: { select: { confidence: true } },
          },
        },
      },
    });

    if (!doc) return null;

    // Enforce tenant-scoped access
    if (tenantId && doc.tenantId !== tenantId) {
      return null;
    }

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(
      documentId,
      doc.jobId,
      citations,
      Date.now(),
      doc.originalName || doc.fileName
    );
  }

  /**
   * Get detection results by job ID
   * @param jobId - Job ID
   * @param tenantId - Optional tenant ID for cross-tenant protection
   */
  async getDetectionResultsByJob(
    jobId: string,
    tenantId?: string
  ): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findFirst({
      where: {
        jobId,
        ...(tenantId && { tenantId }),
      },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' },
          include: {
            primaryComponent: { select: { confidence: true } },
          },
        },
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(
      doc.id,
      jobId,
      citations,
      Date.now(),
      doc.originalName || doc.fileName
    );
  }

  /**
   * Get detection results by looking up the Job record and extracting documentId from output
   * This is the preferred method for retrieving results after detection
   * @param jobId - Job ID
   * @param tenantId - Optional tenant ID for cross-tenant protection
   */
  async getResultsByJobId(jobId: string, tenantId?: string): Promise<DetectionResult | null> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) return null;

    // Enforce tenant-scoped access
    if (tenantId && job.tenantId !== tenantId) {
      return null;
    }

    // Job must be a citation detection job
    if (job.type !== 'CITATION_DETECTION') {
      return null;
    }

    // Extract documentId from job output
    const output = job.output as { documentId?: string } | null;
    if (!output?.documentId) {
      return null;
    }

    // Fetch the document and its citations
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: output.documentId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' },
          include: {
            primaryComponent: { select: { confidence: true } },
          },
        },
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(
      doc.id,
      jobId,
      citations,
      Date.now(),
      doc.originalName || doc.fileName
    );
  }

  /**
   * Re-run detection on an existing document
   * Deletes existing citations and creates new ones
   * Uses atomic transaction to prevent inconsistent state
   */
  async redetectCitations(documentId: string, tenantId?: string): Promise<DetectionResult> {
    const startTime = Date.now();

    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new Error(`Editorial document not found: ${documentId}`);
    }

    if (tenantId && doc.tenantId !== tenantId) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!doc.fullText) {
      throw new Error(`Document has no extracted text: ${documentId}`);
    }

    logger.info(`[Citation Detection] Re-detecting for documentId=${documentId}`);

    // Detect citations FIRST (before any DB mutations)
    const extractedCitations = await editorialAi.detectCitations(doc.fullText);

    const citations = await prisma.$transaction(
      async tx => {
        await tx.citation.deleteMany({
          where: { documentId },
        });

        const stored = await Promise.all(
          extractedCitations.map(async extracted => {
            return tx.citation.create({
              data: {
                documentId,
                rawText: extracted.text,
                startOffset: extracted.location.startOffset,
                endOffset: extracted.location.endOffset,
                pageNumber: extracted.location.pageNumber || null,
                paragraphIndex: extracted.location.paragraphIndex,
                citationType: mapToCitationType(extracted.type),
                detectedStyle: mapToCitationStyle(extracted.style),
                sectionContext: mapToSectionContext(extracted.sectionContext) as
                  | 'BODY'
                  | 'REFERENCES'
                  | 'FOOTNOTES'
                  | 'ENDNOTES'
                  | 'ABSTRACT'
                  | 'UNKNOWN',
                confidence: extracted.confidence / 100,
                isValid: null,
                validationErrors: [],
              },
            });
          })
        );

        await tx.editorialDocument.update({
          where: { id: documentId },
          data: { status: EditorialDocStatus.PARSED },
        });

        return stored;
      },
      { timeout: 30000 }
    );

    // Map to DetectedCitation with parsing status
    const mappedCitations = citations.map(c => ({
      ...c,
      primaryComponentId: c.primaryComponentId ?? null,
      isParsed: c.primaryComponentId !== null,
      parseConfidence: null as number | null, // Newly re-detected, no components yet
    }));

    return this.buildDetectionResult(
      documentId,
      doc.jobId,
      mappedCitations,
      startTime,
      doc.originalName || doc.fileName
    );
  }

  /**
   * Create EditorialDocument record
   */
  private async createEditorialDocument(
    jobId: string,
    tenantId: string,
    fileName: string,
    fileSize: number,
    parsed: Awaited<ReturnType<typeof documentParser.parse>>
  ) {
    // Check if document already exists for this job
    const existing = await prisma.editorialDocument.findUnique({
      where: { jobId },
    });

    if (existing) {
      return prisma.editorialDocument.update({
        where: { id: existing.id },
        data: {
          fullText: parsed.text,
          fullHtml: parsed.html || null,
          wordCount: parsed.metadata.wordCount,
          pageCount: parsed.metadata.pageCount || null,
          chunkCount: parsed.chunks.length,
          title: parsed.metadata.title || null,
          authors: parsed.metadata.authors || [],
          language: parsed.metadata.language || null,
          status: EditorialDocStatus.ANALYZING,
          parsedAt: new Date(),
        },
      });
    }

    return prisma.editorialDocument.create({
      data: {
        tenantId,
        jobId,
        fileName,
        originalName: fileName,
        mimeType: this.getMimeType(fileName),
        fileSize,
        storagePath: '',
        fullText: parsed.text,
        fullHtml: parsed.html || null,
        wordCount: parsed.metadata.wordCount,
        pageCount: parsed.metadata.pageCount || null,
        chunkCount: parsed.chunks.length,
        title: parsed.metadata.title || null,
        authors: parsed.metadata.authors || [],
        language: parsed.metadata.language || null,
        status: EditorialDocStatus.ANALYZING,
        parsedAt: new Date(),
      },
    });
  }

  /**
   * Store detected citations in database
   */
  private async storeCitations(
    documentId: string,
    extractedCitations: Awaited<ReturnType<typeof editorialAi.detectCitations>>
  ): Promise<DetectedCitation[]> {
    const citations: DetectedCitation[] = [];

    for (const extracted of extractedCitations) {
      try {
        const citation = await prisma.citation.create({
          data: {
            documentId,
            rawText: extracted.text,
            citationType: mapToCitationType(extracted.type),
            detectedStyle: mapToCitationStyle(extracted.style),
            sectionContext: mapToSectionContext(extracted.sectionContext) as
              | 'BODY'
              | 'REFERENCES'
              | 'FOOTNOTES'
              | 'ENDNOTES'
              | 'ABSTRACT'
              | 'UNKNOWN',
            pageNumber: extracted.location.pageNumber || null,
            paragraphIndex: extracted.location.paragraphIndex,
            startOffset: extracted.location.startOffset,
            endOffset: extracted.location.endOffset,
            confidence: extracted.confidence / 100, // Normalize to 0-1
            isValid: null, // Not validated yet
            validationErrors: [],
          },
        });

        citations.push({
          id: citation.id,
          rawText: citation.rawText,
          citationType: citation.citationType,
          detectedStyle: citation.detectedStyle,
          pageNumber: citation.pageNumber,
          paragraphIndex: citation.paragraphIndex,
          startOffset: citation.startOffset,
          endOffset: citation.endOffset,
          confidence: citation.confidence,
          primaryComponentId: null, // Newly created, not parsed yet
          isParsed: false,
          parseConfidence: null,
        });
      } catch (error) {
        logger.warn(
          `[Citation Detection] Failed to store citation: documentId=${documentId}, offsets=${extracted.location.startOffset}-${extracted.location.endOffset}`,
          error instanceof Error ? error : undefined
        );
      }
    }

    return citations;
  }

  /**
   * Map Prisma Citation records to DetectedCitation interface
   */
  private mapCitationsToDetected(
    citations: Array<{
      id: string;
      rawText: string;
      citationType: string;
      detectedStyle: string | null;
      pageNumber: number | null;
      paragraphIndex: number | null;
      startOffset: number;
      endOffset: number;
      confidence: number;
      primaryComponentId: string | null;
      primaryComponent?: { confidence: number } | null;
    }>
  ): DetectedCitation[] {
    return citations.map(c => ({
      id: c.id,
      rawText: c.rawText,
      citationType: c.citationType as DetectedCitation['citationType'],
      detectedStyle: c.detectedStyle as DetectedCitation['detectedStyle'],
      pageNumber: c.pageNumber,
      paragraphIndex: c.paragraphIndex,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      confidence: c.confidence,
      primaryComponentId: c.primaryComponentId,
      isParsed: c.primaryComponentId !== null,
      parseConfidence: c.primaryComponent?.confidence ?? null,
    }));
  }

  /**
   * Build detection result with statistics
   */
  private buildDetectionResult(
    documentId: string,
    jobId: string,
    citations: DetectedCitation[],
    startTime: number,
    filename?: string
  ): DetectionResult {
    const byType: Record<string, number> = {};
    const byStyle: Record<string, number> = {};

    for (const citation of citations) {
      // Count by type
      byType[citation.citationType] = (byType[citation.citationType] || 0) + 1;

      // Count by style
      const style = citation.detectedStyle || 'UNKNOWN';
      byStyle[style] = (byStyle[style] || 0) + 1;
    }

    return {
      documentId,
      jobId,
      filename,
      citations,
      totalCount: citations.length,
      byType,
      byStyle,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Get MIME type from filename
   */
  private getMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      epub: 'application/epub+zip',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xml: 'application/xml',
      txt: 'text/plain',
    };
    return mimeMap[ext || ''] || 'application/octet-stream';
  }
}

// Export singleton instance
export const citationDetectionService = new CitationDetectionService();
