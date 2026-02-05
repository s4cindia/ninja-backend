/**
 * Citation Controller
 * HTTP request handlers for citation detection and parsing APIs
 */

import { Request, Response, NextFunction } from 'express';
import { citationDetectionService } from './citation-detection.service';
import { citationParsingService } from './citation-parsing.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export class CitationController {
  /**
   * POST /api/v1/citation/detect
   * Detect citations from file upload, S3 reference, or job reference
   * Supports three modes:
   * 1. Direct file upload via multipart form (req.file)
   * 2. S3 key reference (fileS3Key or presignedUrl in body)
   * 3. Job reference (jobId in body to get existing results)
   */
  async detectFromUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { fileS3Key, presignedUrl, fileName, fileSize, jobId: existingJobId } = req.body as {
        fileS3Key?: string;
        presignedUrl?: string;
        fileName?: string;
        fileSize?: number;
        jobId?: string;
      };

      // Mode 3: Job reference - return existing results
      if (existingJobId) {
        const result = await citationDetectionService.getDetectionResultsByJob(existingJobId, tenantId);
        if (!result) {
          res.status(404).json({ success: false, error: 'Job not found or no detection results' });
          return;
        }
        res.status(200).json({ success: true, data: result });
        return;
      }

      // Mode 1: Direct file upload via multipart form
      if (req.file) {
        const result = await citationDetectionService.detectFromBuffer(
          tenantId,
          userId,
          req.file.buffer,
          req.file.originalname
        );

        res.status(201).json({ success: true, data: result });
        return;
      }

      // Mode 2: S3 key reference
      if (!fileS3Key && !presignedUrl) {
        res.status(400).json({ success: false, error: 'Provide file upload, fileS3Key, presignedUrl, or jobId' });
        return;
      }

      // Derive fileName from S3 key if not provided
      const resolvedFileName = fileName || (fileS3Key ? fileS3Key.split('/').pop() || 'unknown' : 'document');

      const result = await citationDetectionService.detectFromS3(
        tenantId,
        userId,
        fileS3Key,
        presignedUrl,
        resolvedFileName,
        fileSize
      );

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] detectFromUpload failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId
   * Get detection results by job ID
   */
  async getCitationsByJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Use getResultsByJobId which looks up Job record and extracts documentId from output
      const result = await citationDetectionService.getResultsByJobId(jobId, tenantId);

      if (!result) {
        res.status(404).json({ success: false, error: 'No citations found for this job' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitationsByJob failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId
   * Get all citations for a document
   */
  async getCitations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationDetectionService.getDetectionResults(documentId, tenantId);

      if (!result) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/redetect
   * Re-run detection on existing document
   */
  async redetect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationDetectionService.redetectCitations(documentId, tenantId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] redetect failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/:citationId/parse
   * Parse a single citation into components
   */
  async parseCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.parseCitation(citationId, tenantId);

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] parseCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/parse-all
   * Parse all citations in a document
   */
  async parseAllCitations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.parseAllCitations(documentId, tenantId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] parseAllCitations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/:citationId
   * Get single citation with latest component
   */
  async getCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationWithComponent(citationId, tenantId);

      if (!result) {
        res.status(404).json({ success: false, error: 'Citation not found' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/:citationId/components
   * Get all components for a citation (version history)
   */
  async getComponents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationComponents(citationId, tenantId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getComponents failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/:citationId/reparse
   * Re-parse a citation (creates new component version)
   */
  async reparseCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.reparseCitation(citationId, tenantId);

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] reparseCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/with-components
   * Get all citations with their components
   */
  async getCitationsWithComponents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationsWithComponents(documentId, tenantId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitationsWithComponents failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/stats
   * Get citation statistics for a document
   */
  async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      // Verify document belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, originalName: true, fileName: true },
      });

      if (!document) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      // Fetch all citations for aggregation
      const citations = await prisma.citation.findMany({
        where: { documentId },
        select: {
          citationType: true,
          detectedStyle: true,
          primaryComponentId: true,
          confidence: true,
        },
      });

      const total = citations.length;
      const parsed = citations.filter((c) => c.primaryComponentId !== null).length;
      const unparsed = total - parsed;

      // needsReview: citations with low confidence (< 0.7) that need manual review
      const needsReview = citations.filter((c) => c.confidence < 0.7 && c.primaryComponentId !== null).length;

      // Calculate average confidence (use detection confidence, normalize 0-1 to 0-100)
      let averageConfidence = 0;
      if (total > 0) {
        const totalConfidence = citations.reduce((sum, c) => {
          // Confidence is stored as 0-1, convert to 0-100
          const conf = c.confidence <= 1 ? c.confidence * 100 : c.confidence;
          return sum + conf;
        }, 0);
        averageConfidence = Math.round(totalConfidence / total);
      }

      // Count by type
      const byType: Record<string, number> = {};
      for (const c of citations) {
        byType[c.citationType] = (byType[c.citationType] || 0) + 1;
      }

      // Count by style
      const byStyle: Record<string, number> = {};
      for (const c of citations) {
        const style = c.detectedStyle || 'UNKNOWN';
        byStyle[style] = (byStyle[style] || 0) + 1;
      }

      res.json({
        success: true,
        data: {
          total,
          parsed,
          unparsed,
          needsReview,
          averageConfidence,
          byType,
          byStyle,
          fileName: document.originalName || document.fileName,
        },
      });
    } catch (error) {
      logger.error('[Citation Controller] getStats failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

// Export singleton instance
export const citationController = new CitationController();
