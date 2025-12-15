import { Request, Response, NextFunction } from 'express';
import { section508MapperService, WcagValidationResult } from '../services/compliance/section508-mapper.service';
import { fpcValidatorService } from '../services/compliance/fpc-validator.service';
import { pdfUaValidatorService } from '../services/accessibility/pdfua-validator.service';
import { validateFilePath } from '../utils/path-validator';

export class ComplianceController {
  async mapSection508(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, wcagResults, includePdfUa = true } = req.body;

      if (!filePath && !wcagResults) {
        return res.status(400).json({
          success: false,
          error: { message: 'Either filePath or wcagResults is required' },
        });
      }

      let validatedPath: string | null = null;
      let pdfUaResult: { isPdfUaCompliant: boolean; pdfUaVersion: string | null } | undefined;

      if (filePath) {
        validatedPath = await validateFilePath(filePath);

        if (includePdfUa) {
          const pdfUaValidation = await pdfUaValidatorService.validatePdfUa(validatedPath);
          pdfUaResult = {
            isPdfUaCompliant: pdfUaValidation.isPdfUaCompliant,
            pdfUaVersion: pdfUaValidation.pdfUaVersion,
          };
        }
      }

      const validationResults: WcagValidationResult[] = wcagResults || [];

      if (validationResults.length === 0 && !validatedPath) {
        return res.status(400).json({
          success: false,
          error: { message: 'wcagResults array is required when filePath is not provided' },
        });
      }

      const result = section508MapperService.mapWcagToSection508(
        validationResults,
        pdfUaResult,
        req.body.competitorContext
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async mapSection508ByJobId(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.body;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: { message: 'jobId is required' },
        });
      }

      return res.status(501).json({
        success: false,
        error: { 
          message: 'Job-based Section 508 mapping requires pipeline integration. Use filePath with wcagResults instead.',
          hint: 'POST /api/v1/compliance/section508/map with { filePath, wcagResults }',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async validateFpc(req: Request, res: Response, next: NextFunction) {
    try {
      const { wcagResults } = req.body;

      if (!wcagResults || !Array.isArray(wcagResults)) {
        return res.status(400).json({
          success: false,
          error: { message: 'wcagResults array is required' },
        });
      }

      const result = fpcValidatorService.validateFpc(wcagResults);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async validateFpcCriterion(req: Request, res: Response, next: NextFunction) {
    try {
      const { criterionId } = req.params;
      const { wcagResults } = req.body;

      if (!wcagResults || !Array.isArray(wcagResults)) {
        return res.status(400).json({
          success: false,
          error: { message: 'wcagResults array is required' },
        });
      }

      const result = fpcValidatorService.validateSingleCriterion(criterionId, wcagResults);

      if (!result) {
        const definitions = fpcValidatorService.getFpcDefinitions();
        return res.status(404).json({
          success: false,
          error: { 
            message: `FPC criterion ${criterionId} not found`,
            availableCriteria: definitions.map(d => d.id),
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getFpcDefinitions(_req: Request, res: Response, next: NextFunction) {
    try {
      const definitions = fpcValidatorService.getFpcDefinitions();

      return res.status(200).json({
        success: true,
        data: {
          count: definitions.length,
          criteria: definitions,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const complianceController = new ComplianceController();
