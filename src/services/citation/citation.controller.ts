/**
 * Citation Controller
 * HTTP request handlers for citation detection and parsing APIs
 */

import { Request, Response, NextFunction } from 'express';
import { citationDetectionService } from './citation-detection.service';
import { citationParsingService } from './citation-parsing.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DetectionInput } from './citation.types';

export class CitationController {
  /**
   * POST /api/v1/citation/detect
   * Upload file and detect citations
   */
  async detectFromUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { fileS3Key, presignedUrl, fileName, fileSize } = req.body as {
        fileS3Key?: string;
        presignedUrl?: string;
        fileName?: string;
        fileSize?: number;
      };

      if (!fileName) {
        res.status(400).json({ success: false, error: 'fileName is required' });
        return;
      }

      if (!fileS3Key && !presignedUrl) {
        res.status(400).json({ success: false, error: 'Either fileS3Key or presignedUrl is required' });
        return;
      }

      // Create job for audit trail
      // Note: presignedUrl intentionally excluded - temporary credentials should not be persisted
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_VALIDATION',
          status: 'PROCESSING',
          input: { fileS3Key, fileName, fileSize },
          startedAt: new Date(),
        },
      });

      try {
        const input: DetectionInput = {
          jobId: job.id,
          tenantId,
          userId,
          fileS3Key,
          presignedUrl,
          fileName,
          fileSize,
        };

        const result = await citationDetectionService.detectCitations(input);

        // Update job to completed
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            output: result as object,
          },
        });

        res.status(201).json({ success: true, data: result });
      } catch (error) {
        // Update job to failed with nested try-catch to preserve original error
        try {
          await prisma.job.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        } catch (updateError) {
          logger.error(`[Citation Controller] Failed to update job ${job.id} status to FAILED`, updateError instanceof Error ? updateError : undefined);
        }
        throw error;
      }
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

      const result = await citationDetectionService.getDetectionResultsByJob(jobId, tenantId);

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
}

// Export singleton instance
export const citationController = new CitationController();
