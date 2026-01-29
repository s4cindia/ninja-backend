/**
 * Citation Detection Service
 * US-4.1: Detect and extract citations from documents
 */

import { editorialAi, documentParser } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorialDocStatus } from '@prisma/client';
import {
  DetectedCitation,
  DetectionResult,
  DetectionInput,
  mapToCitationType,
  mapToCitationStyle,
} from './citation.types';

export class CitationDetectionService {
  /**
   * Detect all citations in a document
   * Main entry point for US-4.1
   *
   * @param input - Detection input with file buffer and metadata
   * @returns Detection result with all found citations
   */
  async detectCitations(input: DetectionInput): Promise<DetectionResult> {
    const startTime = Date.now();
    const { jobId, tenantId, fileBuffer, fileName } = input;

    logger.info(`[Citation Detection] Starting for jobId=${jobId}, file=${fileName}`);

    try {
      // 1. Parse document to extract text
      const parsed = await documentParser.parse(fileBuffer, fileName);
      logger.info(`[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`);

      // 2. Create or update EditorialDocument record
      const editorialDoc = await this.createEditorialDocument(
        jobId,
        tenantId,
        fileName,
        fileBuffer.length,
        parsed
      );

      // 3. Detect citations using AI
      const extractedCitations = await editorialAi.detectCitations(parsed.text);
      logger.info(`[Citation Detection] AI found ${extractedCitations.length} citations`);

      // 4. Store citations in database
      const citations = await this.storeCitations(editorialDoc.id, extractedCitations);

      // 5. Update document status
      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      // 6. Build and return result
      const result = this.buildDetectionResult(editorialDoc.id, jobId, citations, startTime);

      logger.info(`[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`);
      return result;

    } catch (error) {
      logger.error('[Citation Detection] Failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get detection results for an existing document
   */
  async getDetectionResults(documentId: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(documentId, doc.jobId, citations, Date.now());
  }

  /**
   * Get detection results by job ID
   */
  async getDetectionResultsByJob(jobId: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { jobId },
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
   */
  async redetectCitations(documentId: string): Promise<DetectionResult> {
    const startTime = Date.now();

    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new Error(`Editorial document not found: ${documentId}`);
    }

    if (!doc.fullText) {
      throw new Error(`Document has no extracted text: ${documentId}`);
    }

    logger.info(`[Citation Detection] Re-detecting for documentId=${documentId}`);

    // Delete existing citations
    await prisma.citation.deleteMany({
      where: { documentId },
    });

    // Update status
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: EditorialDocStatus.ANALYZING },
    });

    // Re-detect
    const extractedCitations = await editorialAi.detectCitations(doc.fullText);
    const citations = await this.storeCitations(documentId, extractedCitations);

    // Update status
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: EditorialDocStatus.PARSED },
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
        logger.warn(`[Citation Detection] Failed to store citation: ${extracted.text.substring(0, 50)}...`,
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
