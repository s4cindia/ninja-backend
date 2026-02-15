/**
 * Citation Upload Controller
 * Handles document upload and analysis operations
 *
 * Endpoints:
 * - POST /upload - Upload and analyze DOCX
 * - POST /document/:documentId/reanalyze - Re-analyze document
 * - GET /document/:documentId/analysis - Get analysis results
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiCitationDetectorService } from '../../services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../services/citation/docx-processor.service';

export class CitationUploadController {
  /**
   * POST /api/v1/citation-management/upload
   * Upload DOCX and start AI analysis
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

      logger.info(`[CitationUpload] Upload: ${file.originalname}`);

      // Validate DOCX
      const validation = await docxProcessorService.validateDOCX(file.buffer);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DOCX', message: validation.error }
        });
        return;
      }

      // Extract text
      const content = await docxProcessorService.extractText(file.buffer);
      const stats = await docxProcessorService.getStatistics(file.buffer);

      // Create Job
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

      // Save original DOCX file
      const fs = await import('fs/promises');
      const path = await import('path');
      const uploadDir = path.join(process.cwd(), 'uploads', 'citation-management', tenantId);
      await fs.mkdir(uploadDir, { recursive: true });

      // Sanitize filename
      const sanitizedOriginalName = file.originalname
        .replace(/\0/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .slice(0, 200);
      const filename = `${Date.now()}-${sanitizedOriginalName}`;
      const storagePath = path.join(uploadDir, filename);
      await fs.writeFile(storagePath, file.buffer);

      // Create document record
      const document = await prisma.editorialDocument.create({
        data: {
          tenantId,
          jobId: job.id,
          originalName: file.originalname,
          fileName: filename,
          mimeType: file.mimetype,
          fileSize: file.size,
          storagePath: `citation-management/${tenantId}/${filename}`,
          storageType: 'LOCAL',
          fullText: content.text,
          fullHtml: content.html,
          wordCount: stats.wordCount,
          pageCount: stats.pageCount,
          status: 'ANALYZING'
        }
      });

      // Run AI analysis
      await this.analyzeDocument(document.id, content.text);

      // Get final counts
      const finalDoc = await prisma.editorialDocument.findUnique({
        where: { id: document.id },
        include: { citations: true }
      });

      const finalRefs = await prisma.referenceListEntry.count({
        where: { documentId: document.id }
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
      logger.error('[CitationUpload] Upload failed:', error);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/reanalyze
   * Re-analyze document
   */
  async reanalyze(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, fullText: true, originalName: true }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      if (!document.fullText) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_TEXT', message: 'Document has no text content' }
        });
        return;
      }

      logger.info(`[CitationUpload] Re-analyzing document ${documentId}`);

      // Clear existing data
      await prisma.citation.deleteMany({ where: { documentId } });
      await prisma.referenceListEntry.deleteMany({ where: { documentId } });
      await prisma.citationChange.deleteMany({ where: { documentId } });

      // Re-run analysis
      await this.analyzeDocument(documentId, document.fullText);

      const citations = await prisma.citation.count({ where: { documentId } });
      const references = await prisma.referenceListEntry.count({ where: { documentId } });

      res.json({
        success: true,
        data: {
          documentId,
          message: 'Document re-analyzed with auto-resequencing',
          citationsFound: citations,
          referencesFound: references
        }
      });
    } catch (error) {
      logger.error('[CitationUpload] Re-analyze failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/analysis
   * Get complete citation analysis
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

      const references = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' }
      });

      // Get style conversions
      const refStyleConversions = await prisma.citationChange.findMany({
        where: {
          documentId,
          changeType: 'REFERENCE_STYLE_CONVERSION',
          isReverted: false
        }
      });

      const refIdToConvertedText = new Map<string, string>();
      for (const change of refStyleConversions) {
        if (change.citationId && change.afterText) {
          refIdToConvertedText.set(change.citationId, change.afterText);
        }
      }

      // Build citation-to-reference mapping
      const citationToRefMap = new Map<string, number>();
      references.forEach((ref, index) => {
        const refNumber = parseInt(ref.sortKey) || (index + 1);
        ref.citationIds.forEach(citationId => {
          citationToRefMap.set(citationId, refNumber);
        });
      });

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            filename: document.originalName,
            status: document.status,
            wordCount: document.wordCount,
            pageCount: document.pageCount,
            fullText: document.fullText,
            fullHtml: document.fullHtml,
            statistics: {
              totalCitations: document.citations?.length || 0,
              totalReferences: references.length
            }
          },
          citations: (document.citations || []).map(c => ({
            ...c,
            referenceNumber: citationToRefMap.get(c.id) || null
          })),
          references: references.map((r, index) => {
            const refNumber = parseInt(r.sortKey) || (index + 1);
            const convertedText = refIdToConvertedText.get(r.id);
            return {
              id: r.id,
              position: refNumber,
              number: refNumber,
              rawText: convertedText || r.formattedApa || `${(r.authors as string[])?.join(', ') || 'Unknown'} (${r.year || 'n.d.'}). ${r.title || 'Untitled'}`,
              authors: r.authors,
              year: r.year,
              title: r.title,
              journal: r.journalName,
              volume: r.volume,
              issue: r.issue,
              pages: r.pages,
              doi: r.doi,
              url: r.url,
              publisher: r.publisher,
              citationCount: r.citationIds.length
            };
          }),
          detectedStyle: document.referenceListStyle || 'APA'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Analyze document citations using AI
   */
  private async analyzeDocument(documentId: string, documentText: string): Promise<void> {
    try {
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'ANALYZING' }
      });

      // Run AI analysis
      const analysis = await aiCitationDetectorService.analyzeDocument(documentText);

      logger.info(`[CitationUpload] AI detected ${analysis.inTextCitations.length} citations, ${analysis.references.length} references`);

      // Store citations
      if (analysis.inTextCitations.length > 0) {
        await prisma.citation.createMany({
          data: analysis.inTextCitations.map((c, index) => ({
            documentId,
            rawText: c.text || `[${index + 1}]`,
            citationType: c.type === 'numeric' ? 'NUMERIC' : 'AUTHOR_YEAR',
            startOffset: c.position?.startChar || 0,
            endOffset: c.position?.endChar || 0,
            paragraphIndex: c.position?.paragraph || 0
          }))
        });
      }

      // Store references
      if (analysis.references.length > 0) {
        await prisma.referenceListEntry.createMany({
          data: analysis.references.map((r, index) => ({
            documentId,
            sortKey: String(index + 1).padStart(4, '0'),
            rawText: r.text || '',
            formattedApa: r.text || '',
            authors: r.components?.authors || [],
            year: r.components?.year || null,
            title: r.components?.title || null,
            journalName: r.components?.journal || null,
            volume: r.components?.volume || null,
            issue: r.components?.issue || null,
            pages: r.components?.pages || null,
            doi: r.components?.doi || null,
            url: r.components?.url || null,
            publisher: r.components?.publisher || null,
            citationIds: []
          }))
        });
      }

      // Update document status
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: {
          status: 'COMPLETED',
          referenceListStyle: analysis.detectedStyle || 'Unknown'
        }
      });

      logger.info(`[CitationUpload] Analysis complete for document ${documentId}`);
    } catch (error) {
      logger.error(`[CitationUpload] Analysis failed for ${documentId}:`, error);

      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'FAILED' }
      });

      throw error;
    }
  }
}

export const citationUploadController = new CitationUploadController();
