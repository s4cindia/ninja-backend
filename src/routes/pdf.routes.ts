import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { pdfParserService } from '../services/pdf/pdf-parser.service';

const router = Router();

router.post('/parse', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: { message: 'filePath is required' },
      });
    }

    const parsedPdf = await pdfParserService.parse(filePath);

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

    const parsedPdf = await pdfParserService.parse(filePath);
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

    const parsedPdf = await pdfParserService.parse(filePath);
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
