import { Request, Response, NextFunction } from 'express';
import { referenceListService } from '../services/citation/reference-list.service';
import { logger } from '../lib/logger';

export class ReferenceListController {
  async getReferenceList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode } = req.query;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await referenceListService.getReferenceList(
        documentId,
        (styleCode as string) || '',
        tenantId
      );

      if (!result) {
        res.json({ success: true, data: null });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Reference List Controller] get failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async generateReferenceList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!styleCode) {
        res.status(400).json({ success: false, error: 'styleCode is required' });
        return;
      }

      const result = await referenceListService.generateReferenceList(
        documentId,
        styleCode,
        tenantId,
        options
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Reference List Controller] generate failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async updateEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { entryId } = req.params;
      const updates = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const entry = await referenceListService.updateEntry(entryId, updates, tenantId);
      res.json({ success: true, data: entry });
    } catch (error) {
      logger.error('[Reference List Controller] updateEntry failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async finalizeReferenceList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await referenceListService.finalizeReferenceList(
        documentId,
        styleCode,
        tenantId
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Reference List Controller] finalize failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const referenceListController = new ReferenceListController();
