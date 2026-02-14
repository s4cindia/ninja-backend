import { Request, Response, NextFunction } from 'express';
import { citationCorrectionService } from '../services/citation/citation-correction.service';
import { logger } from '../lib/logger';

export class CitationCorrectionController {
  async acceptCorrection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationCorrectionService.acceptCorrection(validationId, tenantId);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] acceptCorrection failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async rejectCorrection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const { reason } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      await citationCorrectionService.rejectCorrection(validationId, tenantId, reason);
      res.json({ success: true });
    } catch (error) {
      logger.error('[Correction Controller] rejectCorrection failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async applyManualEdit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const { correctedText } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!correctedText) {
        res.status(400).json({ success: false, error: 'correctedText is required' });
        return;
      }

      const result = await citationCorrectionService.applyManualEdit(
        validationId,
        correctedText,
        tenantId
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] applyManualEdit failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async batchCorrect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { validationIds, violationType, applyAll } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationCorrectionService.batchCorrect(documentId, tenantId, {
        validationIds,
        violationType,
        applyAll
      });

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] batchCorrect failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async getChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const changes = await citationCorrectionService.getChanges(documentId, tenantId);
      res.json({ success: true, data: changes });
    } catch (error) {
      logger.error('[Correction Controller] getChanges failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async revertChange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { changeId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      await citationCorrectionService.revertChange(changeId, tenantId);
      res.json({ success: true });
    } catch (error) {
      logger.error('[Correction Controller] revertChange failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const citationCorrectionController = new CitationCorrectionController();
