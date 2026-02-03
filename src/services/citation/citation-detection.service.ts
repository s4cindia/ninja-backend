/**
 * Citation Detection Service
 * US-4.1: Detect and extract citations from documents
 */

import { editorialAi, documentParser } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorialDocStatus } from '@prisma/client';
import { s3Service } from '../s3.service';
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

    logger.info(`[Citation Detection] Starting from S3 for file=${fileName}, s3Key=${fileS3Key || 'N/A'}, presignedUrl=${presignedUrl ? 'provided' : 'N/A'}`);

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
        fileBuffer = await s3Service.getFileBuffer(fileS3Key);
      } else if (presignedUrl) {
        const FETCH_TIMEOUT_MS = 10000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        
        try {
          const response = await fetch(presignedUrl, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`Failed to fetch file from presigned URL: ${response.status} ${response.statusText}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          fileBuffer = Buffer.from(arrayBuffer);
        } catch (fetchError) {
          if (controller.signal.aborted) {
            throw new Error(`Presigned URL fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
          }
          throw fetchError;
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        throw new Error('Either fileS3Key or presignedUrl is required');
      }
      const actualSize = fileSize ?? fileBuffer.length;
      logger.info(`[Citation Detection] Fetched file: ${actualSize} bytes`);

      // 3. Parse document to extract text
      const parsed = await documentParser.parse(fileBuffer, fileName);
      logger.info(`[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`);

      // 4. Create or update EditorialDocument record
      const editorialDoc = await this.createEditorialDocument(
        jobId,
        tenantId,
        fileName,
        fileBuffer.length,
        parsed
      );

      // 5. Detect citations using AI
      const extractedCitations = await editorialAi.detectCitations(parsed.text);
      logger.info(`[Citation Detection] AI found ${extractedCitations.length} citations`);

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
      const result = this.buildDetectionResult(editorialDoc.id, jobId, citations, startTime);

      logger.info(`[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`);
      return result;

    } catch (error) {
      logger.error('[Citation Detection] Failed', error instanceof Error ? error : undefined);
      throw error;
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

    logger.info(`[Citation Detection] Starting from buffer for file=${fileName}, size=${fileBuffer.length}`);

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
      logger.info(`[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`);

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
      const result = this.buildDetectionResult(editorialDoc.id, jobId, citations, startTime);

      logger.info(`[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`);
      return result;

    } catch (error) {
      logger.error('[Citation Detection] Failed from buffer', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get detection results for an existing document
   * @param documentId - Document ID
   * @param tenantId - Optional tenant ID for cross-tenant protection
   */
  async getDetectionResults(documentId: string, tenantId?: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    // Enforce tenant-scoped access
    if (tenantId && doc.tenantId !== tenantId) {
      return null;
    }

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(documentId, doc.jobId, citations, Date.now());
  }

  /**
   * Get detection results by job ID
   * @param jobId - Job ID
   * @param tenantId - Optional tenant ID for cross-tenant protection
   */
  async getDetectionResultsByJob(jobId: string, tenantId?: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findFirst({
      where: {
        jobId,
        ...(tenantId && { tenantId }),
      },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(doc.id, jobId, citations, Date.now());
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
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(doc.id, jobId, citations, Date.now());
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

    // Perform atomic transaction: delete old, insert new, update status
    const citations = await prisma.$transaction(async (tx) => {
      // Delete existing citations
      await tx.citation.deleteMany({
        where: { documentId },
      });

      // Store new citations within transaction
      const stored = await Promise.all(
        extractedCitations.map(async (extracted) => {
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
              sectionContext: mapToSectionContext(extracted.sectionContext) as 'BODY' | 'REFERENCES' | 'FOOTNOTES' | 'ENDNOTES' | 'ABSTRACT' | 'UNKNOWN',
              confidence: extracted.confidence / 100,
              isValid: null,
              validationErrors: [],
            },
          });
        })
      );

      // Update document status
      await tx.editorialDocument.update({
        where: { id: documentId },
        data: { status: EditorialDocStatus.PARSED },
      });

      return stored;
    });

    return this.buildDetectionResult(documentId, doc.jobId, citations, startTime);
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
      // Update existing document
      return prisma.editorialDocument.update({
        where: { id: existing.id },
        data: {
          fullText: parsed.text,
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

    // Create new document
    return prisma.editorialDocument.create({
      data: {
        tenantId,
        jobId,
        fileName,
        originalName: fileName,
        mimeType: this.getMimeType(fileName),
        fileSize,
        storagePath: '', // Buffer-based, not stored
        fullText: parsed.text,
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
            sectionContext: mapToSectionContext(extracted.sectionContext) as 'BODY' | 'REFERENCES' | 'FOOTNOTES' | 'ENDNOTES' | 'ABSTRACT' | 'UNKNOWN',
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
        });
      } catch (error) {
        logger.warn(`[Citation Detection] Failed to store citation: documentId=${documentId}, offsets=${extracted.location.startOffset}-${extracted.location.endOffset}`,
          error instanceof Error ? error : undefined);
      }
    }

    return citations;
  }

  /**
   * Map Prisma Citation records to DetectedCitation interface
   */
  private mapCitationsToDetected(citations: Array<{
    id: string;
    rawText: string;
    citationType: string;
    detectedStyle: string | null;
    pageNumber: number | null;
    paragraphIndex: number | null;
    startOffset: number;
    endOffset: number;
    confidence: number;
  }>): DetectedCitation[] {
    return citations.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      citationType: c.citationType as DetectedCitation['citationType'],
      detectedStyle: c.detectedStyle as DetectedCitation['detectedStyle'],
      pageNumber: c.pageNumber,
      paragraphIndex: c.paragraphIndex,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      confidence: c.confidence,
    }));
  }

  /**
   * Build detection result with statistics
   */
  private buildDetectionResult(
    documentId: string,
    jobId: string,
    citations: DetectedCitation[],
    startTime: number
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
