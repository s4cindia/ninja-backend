import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { authenticate } from '../middleware/auth.middleware';
import { pdfParserService } from '../services/pdf/pdf-parser.service';
import { uploadConfig } from '../config/upload.config';
import { AppError } from '../utils/app-error';

const router = Router();

async function validateFilePath(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const uploadsDir = path.resolve(uploadConfig.uploadDir);
  
  let canonicalPath: string;
  let canonicalUploadsDir: string;
  
  try {
    canonicalPath = await fs.realpath(resolvedPath);
    canonicalUploadsDir = await fs.realpath(uploadsDir);
  } catch {
    throw AppError.notFound('File not found');
  }
  
  const relativePath = path.relative(canonicalUploadsDir, canonicalPath);
  
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw AppError.forbidden('Access denied: file path is outside allowed directory');
  }
  
  return canonicalPath;
}

router.post('/parse', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const parsedPdf = await pdfParserService.parse(safePath);

    await pdfParserService.close(parsedPdf);

    res.json({
      success: true,
      data: {
        filePath: parsedPdf.filePath,
        fileSize: parsedPdf.fileSize,
        structure: parsedPdf.structure,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/metadata', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const parsedPdf = await pdfParserService.parse(safePath);
    const metadata = parsedPdf.structure.metadata;
    await pdfParserService.close(parsedPdf);

    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/validate-basics', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const parsedPdf = await pdfParserService.parse(safePath);
    const { metadata } = parsedPdf.structure;

    const issues: Array<{ type: string; severity: string; message: string }> = [];

    if (!metadata.isTagged) {
      issues.push({
        type: 'not-tagged',
        severity: 'critical',
        message: 'PDF is not tagged. Tagged PDFs are essential for accessibility.',
      });
    }

    if (!metadata.language) {
      issues.push({
        type: 'missing-language',
        severity: 'major',
        message: 'Document language is not specified (WCAG 3.1.1).',
      });
    }

    if (!metadata.title) {
      issues.push({
        type: 'missing-title',
        severity: 'minor',
        message: 'Document title is not set in metadata.',
      });
    }

    if (!metadata.hasOutline && parsedPdf.structure.pageCount > 10) {
      issues.push({
        type: 'missing-bookmarks',
        severity: 'minor',
        message: 'Document has no bookmarks/outline. Consider adding for navigation.',
      });
    }

    await pdfParserService.close(parsedPdf);

    res.json({
      success: true,
      data: {
        isTagged: metadata.isTagged,
        hasLanguage: !!metadata.language,
        hasTitle: !!metadata.title,
        hasOutline: metadata.hasOutline,
        pageCount: parsedPdf.structure.pageCount,
        issues,
        passesBasicChecks: issues.filter(i => i.severity === 'critical').length === 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
