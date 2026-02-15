/**
 * Citation Upload Controller
 * Handles document upload and initial analysis
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiCitationDetectorService } from '../../services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../services/citation/docx-processor.service';

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

      // Save original DOCX file
      const fs = await import('fs/promises');
      const path = await import('path');
      const uploadDir = path.join(process.cwd(), 'uploads', 'citation-management', tenantId);
      await fs.mkdir(uploadDir, { recursive: true });

      const sanitizedOriginalName = file.originalname
        .replace(/\0/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .slice(0, 200);
      const filename = `${Date.now()}-${sanitizedOriginalName}`;
      const storagePath = path.join(uploadDir, filename);
      await fs.writeFile(storagePath, file.buffer);

      logger.info(`[Citation Upload] Saved DOCX to ${storagePath}`);

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
      logger.info(`[Citation Upload] Starting analysis for ${document.id}`);
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
        where: { id: documentId, tenantId }
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

      // Re-analyze
      await this.analyzeDocument(documentId, document.fullText || '');

      const citationCount = await prisma.citation.count({ where: { documentId } });
      const refCount = await prisma.referenceListEntry.count({ where: { documentId } });

      res.json({
        success: true,
        data: {
          documentId,
          citationsFound: citationCount,
          referencesFound: refCount
        }
      });
    } catch (error) {
      logger.error('[Citation Upload] Reanalyze failed:', error);
      next(error);
    }
  }

  /**
   * Internal: Run AI analysis on document text
   */
  private async analyzeDocument(documentId: string, documentText: string): Promise<void> {
    try {
      const analysis = await aiCitationDetectorService.analyzeDocument(documentText);

      logger.info(`[Citation Upload] AI detected ${analysis.inTextCitations.length} citations, ${analysis.references.length} references`);

      // Store citations
      for (const citation of analysis.inTextCitations) {
        await prisma.citation.create({
          data: {
            documentId,
            rawText: citation.text || '',
            citationType: citation.type === 'numeric' ? 'NUMERIC' : 'PARENTHETICAL',
            startOffset: citation.position?.startChar || 0,
            endOffset: citation.position?.endChar || 0,
            paragraphIndex: citation.position?.paragraph || 0,
            confidence: 0.8
          }
        });
      }

      // Store references
      for (let i = 0; i < analysis.references.length; i++) {
        const ref = analysis.references[i];
        await prisma.referenceListEntry.create({
          data: {
            documentId,
            sortKey: String(i + 1).padStart(4, '0'),
            authors: ref.components?.authors || [],
            year: ref.components?.year || null,
            title: ref.components?.title || 'Untitled',
            sourceType: 'journal',
            journalName: ref.components?.journal || null,
            volume: ref.components?.volume || null,
            issue: ref.components?.issue || null,
            pages: ref.components?.pages || null,
            doi: ref.components?.doi || null,
            url: ref.components?.url || null,
            publisher: ref.components?.publisher || null,
            citationIds: [],
            enrichmentSource: 'ai',
            enrichmentConfidence: 0.8
          }
        });
      }

      // Update document status
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: {
          status: 'PARSED',
          referenceListStyle: analysis.detectedStyle || 'Unknown'
        }
      });
    } catch (error) {
      logger.error(`[Citation Upload] Analysis failed for ${documentId}:`, error);
      throw error;
    }
  }
}

export const citationUploadController = new CitationUploadController();
