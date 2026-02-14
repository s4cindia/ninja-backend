import { Request, Response, NextFunction } from 'express';
import { citationStyleValidationService } from '../services/citation/citation-style-validation.service';
import { logger } from '../lib/logger';

export class CitationValidationController {
  async validateDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!styleCode) {
        res.status(400).json({ success: false, error: 'styleCode is required' });
        return;
      }

      const result = await citationStyleValidationService.validateDocument(
        documentId,
        styleCode,
        tenantId
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Validation Controller] validateDocument failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async getValidations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { status, severity, violationType } = req.query;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const validations = await citationStyleValidationService.getValidations(
        documentId,
        tenantId,
        {
          status: status as string,
          severity: severity as string,
          violationType: violationType as string
        }
      );

      res.json({ success: true, data: validations });
    } catch (error) {
      logger.error('[Validation Controller] getValidations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async getStyles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const styles = citationStyleValidationService.getAvailableStyles();
      res.json({ success: true, data: styles });
    } catch (error) {
      logger.error('[Validation Controller] getStyles failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const citationValidationController = new CitationValidationController();
