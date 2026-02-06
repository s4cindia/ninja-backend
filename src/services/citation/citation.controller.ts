import { Request, Response, NextFunction } from 'express';
import { citationDetectionService } from './citation-detection.service';
import { citationParsingService } from './citation-parsing.service';
import { citationStylesheetDetectionService } from './citation-stylesheet-detection.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export class CitationController {
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

      if (existingJobId) {
        const result = await citationStylesheetDetectionService.getAnalysisByJobId(existingJobId, tenantId);
        if (!result) {
          res.status(404).json({ success: false, error: 'Job not found or no analysis results' });
          return;
        }
        res.status(200).json({ success: true, data: result });
        return;
      }

      if (req.file) {
        const result = await citationStylesheetDetectionService.analyzeFromBuffer(
          tenantId,
          userId,
          req.file.buffer,
          req.file.originalname
        );
        res.status(201).json({ success: true, data: result });
        return;
      }

      if (!fileS3Key && !presignedUrl) {
        res.status(400).json({ success: false, error: 'Provide file upload, fileS3Key, presignedUrl, or jobId' });
        return;
      }

      const resolvedFileName = fileName || (fileS3Key ? fileS3Key.split('/').pop() || 'unknown' : 'document');

      const result = await citationStylesheetDetectionService.analyzeFromS3(
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

  async getCitationsByJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationStylesheetDetectionService.getAnalysisByJobId(jobId, tenantId);

      if (!result) {
        res.status(404).json({ success: false, error: 'No analysis found for this job' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitationsByJob failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async getCitations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationStylesheetDetectionService.getAnalysisResults(documentId, tenantId);

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

  async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, originalName: true, fileName: true },
      });

      if (!document) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

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

      const needsReview = citations.filter((c) => c.confidence < 0.7 && c.primaryComponentId !== null).length;

      let averageConfidence = 0;
      if (total > 0) {
        const totalConfidence = citations.reduce((sum, c) => {
          const conf = c.confidence <= 1 ? c.confidence * 100 : c.confidence;
          return sum + conf;
        }, 0);
        averageConfidence = Math.round(totalConfidence / total);
      }

      const byType: Record<string, number> = {};
      for (const c of citations) {
        byType[c.citationType] = (byType[c.citationType] || 0) + 1;
      }

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

export const citationController = new CitationController();
