import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { authenticate } from '../middleware/auth.middleware';
import { pdfParserService } from '../services/pdf/pdf-parser.service';
import { textExtractorService } from '../services/pdf/text-extractor.service';
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

router.post('/extract-text', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath, options = {} } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const documentText = await textExtractorService.extractFromFile(safePath, options);

    res.json({
      success: true,
      data: {
        totalPages: documentText.totalPages,
        totalWords: documentText.totalWords,
        totalCharacters: documentText.totalCharacters,
        languages: documentText.languages,
        readingOrder: documentText.readingOrder,
        fullText: documentText.fullText,
        pages: documentText.pages.map(p => ({
          pageNumber: p.pageNumber,
          wordCount: p.wordCount,
          characterCount: p.characterCount,
          text: p.text,
          lineCount: p.lines.length,
          blockCount: p.blocks.length,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/extract-page/:pageNumber', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath, options = {} } = req.body;
    const pageNumber = parseInt(req.params.pageNumber, 10);

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    if (isNaN(pageNumber) || pageNumber < 1) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid page number' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const parsedPdf = await pdfParserService.parse(safePath);
    
    try {
      const [pageText] = await textExtractorService.extractPages(parsedPdf, [pageNumber], options);
      
      res.json({
        success: true,
        data: pageText,
      });
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  } catch (error) {
    next(error);
  }
});

router.post('/text-stats', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const safePath = await validateFilePath(filePath);
    const documentText = await textExtractorService.extractFromFile(safePath, {
      includePositions: false,
      includeFontInfo: false,
      groupIntoLines: true,
      groupIntoBlocks: true,
      normalizeWhitespace: true,
    });

    const headingCount = documentText.pages.reduce(
      (sum, p) => sum + p.lines.filter(l => l.isHeading).length, 0
    );
    
    const blockTypes = documentText.pages.flatMap(p => p.blocks.map(b => b.type));
    const blockTypeCounts = blockTypes.reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    res.json({
      success: true,
      data: {
        totalPages: documentText.totalPages,
        totalWords: documentText.totalWords,
        totalCharacters: documentText.totalCharacters,
        languages: documentText.languages,
        readingOrder: documentText.readingOrder,
        headingCount,
        blockTypeCounts,
        averageWordsPerPage: Math.round(documentText.totalWords / documentText.totalPages),
        averageCharactersPerPage: Math.round(documentText.totalCharacters / documentText.totalPages),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
