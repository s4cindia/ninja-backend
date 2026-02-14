import { Request, Response, NextFunction } from 'express';
import { pdfStructureValidatorService } from '../services/accessibility/pdf-structure-validator.service';
import { pdfUaValidatorService } from '../services/accessibility/pdfua-validator.service';
import { validateFilePath } from '../utils/path-validator';

function recalculateResultForFilteredIssues(
  originalResult: {
    isValid: boolean;
    score: number;
    issues: Array<{ severity: string }>;
    summary: { totalChecks: number; passed: number; failed: number; warnings: number };
    metadata: unknown;
  },
  filteredIssues: Array<{ severity: string }>
) {
  const criticalCount = filteredIssues.filter(i => i.severity === 'critical').length;
  const seriousCount = filteredIssues.filter(i => i.severity === 'serious').length;
  const moderateCount = filteredIssues.filter(i => i.severity === 'moderate').length;
  const minorCount = filteredIssues.filter(i => i.severity === 'minor').length;

  const totalPenalty = (criticalCount * 25) + (seriousCount * 15) + (moderateCount * 5) + (minorCount * 2);
  const score = Math.max(0, Math.min(100, 100 - totalPenalty));

  const failed = criticalCount + seriousCount;
  const warnings = moderateCount + minorCount;
  const totalChecks = filteredIssues.length;

  return {
    isValid: failed === 0,
    score,
    issues: filteredIssues,
    summary: {
      totalChecks,
      passed: totalChecks === 0 ? 0 : Math.max(0, totalChecks - failed - warnings),
      failed,
      warnings,
    },
    metadata: originalResult.metadata,
  };
}

export class AccessibilityController {
  async validateStructure(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId, fileId, filePath } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        targetPath = await validateFilePath(filePath);
      } else if (jobId) {
        return res.status(501).json({
          success: false,
          error: { message: 'jobId lookup requires pipeline integration - use filePath instead' },
        });
      } else if (fileId) {
        return res.status(501).json({
          success: false,
          error: { message: 'fileId lookup requires database integration - use filePath instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const options = {
        validateHeadings: req.body.validateHeadings !== false,
        validateReadingOrder: req.body.validateReadingOrder !== false,
        validateLanguage: req.body.validateLanguage !== false,
      };

      const result = await pdfStructureValidatorService.validateStructure(targetPath, options);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async validateHeadings(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);

      const result = await pdfStructureValidatorService.validateStructure(safePath, {
        validateHeadings: true,
        validateReadingOrder: false,
        validateLanguage: false,
      });

      const headingIssues = result.issues.filter(i => i.wcagCriterion === '1.3.1');

      res.json({
        success: true,
        data: recalculateResultForFilteredIssues(result, headingIssues),
      });
    } catch (error) {
      next(error);
    }
  }

  async validateReadingOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);

      const result = await pdfStructureValidatorService.validateStructure(safePath, {
        validateHeadings: false,
        validateReadingOrder: true,
        validateLanguage: false,
      });

      const readingOrderIssues = result.issues.filter(i => i.wcagCriterion === '1.3.2');

      res.json({
        success: true,
        data: recalculateResultForFilteredIssues(result, readingOrderIssues),
      });
    } catch (error) {
      next(error);
    }
  }

  async validateLanguage(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);

      const result = await pdfStructureValidatorService.validateStructure(safePath, {
        validateHeadings: false,
        validateReadingOrder: false,
        validateLanguage: true,
      });

      const languageIssues = result.issues.filter(i => i.wcagCriterion === '3.1.1');

      res.json({
        success: true,
        data: recalculateResultForFilteredIssues(result, languageIssues),
      });
    } catch (error) {
      next(error);
    }
  }

  async validateAltText(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, jobId } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        targetPath = await validateFilePath(filePath);
      } else if (jobId) {
        return res.status(501).json({
          success: false,
          error: { message: 'jobId lookup requires pipeline integration - use filePath instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const result = await pdfStructureValidatorService.validateAltTextFromFile(targetPath);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async validateContrast(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, jobId } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        targetPath = await validateFilePath(filePath);
      } else if (jobId) {
        return res.status(501).json({
          success: false,
          error: { message: 'jobId lookup requires pipeline integration - use filePath instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const result = await pdfStructureValidatorService.validateContrastFromFile(targetPath);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async validateTables(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, jobId } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        targetPath = await validateFilePath(filePath);
      } else if (jobId) {
        return res.status(501).json({
          success: false,
          error: { message: 'jobId lookup requires pipeline integration - use filePath instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const result = await pdfStructureValidatorService.validateTablesFromFile(targetPath);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async validatePdfUa(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, jobId } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        targetPath = await validateFilePath(filePath);
      } else if (jobId) {
        return res.status(501).json({
          success: false,
          error: { message: 'jobId lookup requires pipeline integration - use filePath instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const result = await pdfUaValidatorService.validatePdfUa(targetPath);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const accessibilityController = new AccessibilityController();
