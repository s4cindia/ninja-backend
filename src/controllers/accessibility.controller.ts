import { Request, Response, NextFunction } from 'express';
import { pdfStructureValidatorService } from '../services/accessibility/pdf-structure-validator.service';
import { validationPipelineService } from '../services/pipeline/validation-pipeline.service';
import path from 'path';
import fs from 'fs/promises';

export class AccessibilityController {
  async validateStructure(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId, fileId, filePath } = req.body;

      let targetPath: string | null = null;

      if (filePath) {
        const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
        let resolvedPath: string;
        
        try {
          resolvedPath = await fs.realpath(filePath);
        } catch {
          return res.status(400).json({
            success: false,
            error: { message: 'File not found or inaccessible' },
          });
        }

        if (!resolvedPath.startsWith(uploadDir + path.sep)) {
          return res.status(403).json({
            success: false,
            error: { message: 'Access denied: file must be in uploads directory' },
          });
        }

        if (!resolvedPath.toLowerCase().endsWith('.pdf')) {
          return res.status(400).json({
            success: false,
            error: { message: 'Only PDF files are allowed' },
          });
        }

        targetPath = resolvedPath;
      } else if (jobId) {
        const job = validationPipelineService.getJob(jobId);
        if (!job) {
          return res.status(404).json({
            success: false,
            error: { message: 'Job not found' },
          });
        }
        targetPath = job.input.filePath;
      } else if (fileId) {
        return res.status(501).json({
          success: false,
          error: { message: 'fileId lookup requires database integration - use filePath or jobId instead' },
        });
      } else {
        return res.status(400).json({
          success: false,
          error: { message: 'Either jobId, fileId, or filePath is required' },
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

      const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
      let resolvedPath: string;
      
      try {
        resolvedPath = await fs.realpath(filePath);
      } catch {
        return res.status(400).json({
          success: false,
          error: { message: 'File not found or inaccessible' },
        });
      }

      if (!resolvedPath.startsWith(uploadDir + path.sep)) {
        return res.status(403).json({
          success: false,
          error: { message: 'Access denied: file must be in uploads directory' },
        });
      }

      const result = await pdfStructureValidatorService.validateStructure(resolvedPath, {
        validateHeadings: true,
        validateReadingOrder: false,
        validateLanguage: false,
      });

      const headingIssues = result.issues.filter(i => i.wcagCriterion === '1.3.1');

      res.json({
        success: true,
        data: {
          ...result,
          issues: headingIssues,
        },
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

      const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
      let resolvedPath: string;
      
      try {
        resolvedPath = await fs.realpath(filePath);
      } catch {
        return res.status(400).json({
          success: false,
          error: { message: 'File not found or inaccessible' },
        });
      }

      if (!resolvedPath.startsWith(uploadDir + path.sep)) {
        return res.status(403).json({
          success: false,
          error: { message: 'Access denied: file must be in uploads directory' },
        });
      }

      const result = await pdfStructureValidatorService.validateStructure(resolvedPath, {
        validateHeadings: false,
        validateReadingOrder: true,
        validateLanguage: false,
      });

      const readingOrderIssues = result.issues.filter(i => i.wcagCriterion === '1.3.2');

      res.json({
        success: true,
        data: {
          ...result,
          issues: readingOrderIssues,
        },
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

      const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
      let resolvedPath: string;
      
      try {
        resolvedPath = await fs.realpath(filePath);
      } catch {
        return res.status(400).json({
          success: false,
          error: { message: 'File not found or inaccessible' },
        });
      }

      if (!resolvedPath.startsWith(uploadDir + path.sep)) {
        return res.status(403).json({
          success: false,
          error: { message: 'Access denied: file must be in uploads directory' },
        });
      }

      const result = await pdfStructureValidatorService.validateStructure(resolvedPath, {
        validateHeadings: false,
        validateReadingOrder: false,
        validateLanguage: true,
      });

      const languageIssues = result.issues.filter(i => i.wcagCriterion === '3.1.1');

      res.json({
        success: true,
        data: {
          ...result,
          issues: languageIssues,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const accessibilityController = new AccessibilityController();
