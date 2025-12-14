import { Request, Response, NextFunction } from 'express';
import { validateFilePath } from '../utils/path-validator';
import { pdfParserService } from '../services/pdf/pdf-parser.service';
import { textExtractorService } from '../services/pdf/text-extractor.service';
import { imageExtractorService } from '../services/pdf/image-extractor.service';
import { structureAnalyzerService } from '../services/pdf/structure-analyzer.service';

export class PdfController {
  async parse(req: Request, res: Response, next: NextFunction) {
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
  }

  async getMetadata(req: Request, res: Response, next: NextFunction) {
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
  }

  async validateBasics(req: Request, res: Response, next: NextFunction) {
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
  }

  async extractText(req: Request, res: Response, next: NextFunction) {
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
  }

  async extractPage(req: Request, res: Response, next: NextFunction) {
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
  }

  async getTextStats(req: Request, res: Response, next: NextFunction) {
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
  }

  async extractImages(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, options = {} } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);

      const extractionOptions = {
        includeBase64: options.includeBase64 ?? false,
        maxImageSize: options.maxImageSize ?? 512,
        pageRange: options.pageRange,
        minWidth: options.minWidth ?? 20,
        minHeight: options.minHeight ?? 20,
      };

      const documentImages = await imageExtractorService.extractFromFile(safePath, extractionOptions);

      res.json({
        success: true,
        data: {
          totalImages: documentImages.totalImages,
          imageFormats: documentImages.imageFormats,
          imagesWithAltText: documentImages.imagesWithAltText,
          imagesWithoutAltText: documentImages.imagesWithoutAltText,
          decorativeImages: documentImages.decorativeImages,
          pages: documentImages.pages.map(p => ({
            pageNumber: p.pageNumber,
            totalImages: p.totalImages,
            images: p.images.map(img => ({
              id: img.id,
              position: img.position,
              dimensions: img.dimensions,
              format: img.format,
              colorSpace: img.colorSpace,
              fileSizeBytes: img.fileSizeBytes,
              hasAlpha: img.hasAlpha,
              altText: img.altText,
              isDecorative: img.isDecorative,
              ...(extractionOptions.includeBase64 && img.base64 ? { base64: img.base64, mimeType: img.mimeType } : {}),
            })),
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getImageById(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath } = req.body;
      const { imageId } = req.params;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);
      const parsedPdf = await pdfParserService.parse(safePath);
      
      try {
        const image = await imageExtractorService.getImageById(parsedPdf, imageId, true);
        
        if (!image) {
          return res.status(404).json({
            success: false,
            error: { message: 'Image not found' },
          });
        }
        
        res.json({
          success: true,
          data: image,
        });
      } finally {
        await pdfParserService.close(parsedPdf);
      }
    } catch (error) {
      next(error);
    }
  }

  async getImageStats(req: Request, res: Response, next: NextFunction) {
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
      
      try {
        const stats = await imageExtractorService.getImageStats(parsedPdf);
        
        res.json({
          success: true,
          data: stats,
        });
      } finally {
        await pdfParserService.close(parsedPdf);
      }
    } catch (error) {
      next(error);
    }
  }

  async analyzeStructure(req: Request, res: Response, next: NextFunction) {
    try {
      const { filePath, options = {} } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: { message: 'filePath is required' },
        });
      }

      const safePath = await validateFilePath(filePath);
      const structure = await structureAnalyzerService.analyzeFromFile(safePath, options);

      res.json({
        success: true,
        data: structure,
      });
    } catch (error) {
      next(error);
    }
  }

  async analyzeHeadings(req: Request, res: Response, next: NextFunction) {
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

      try {
        const headings = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

        res.json({
          success: true,
          data: headings,
        });
      } finally {
        await pdfParserService.close(parsedPdf);
      }
    } catch (error) {
      next(error);
    }
  }

  async analyzeTables(req: Request, res: Response, next: NextFunction) {
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

      try {
        const tables = await structureAnalyzerService.getTablesOnly(parsedPdf);

        res.json({
          success: true,
          data: {
            totalTables: tables.length,
            tables,
          },
        });
      } finally {
        await pdfParserService.close(parsedPdf);
      }
    } catch (error) {
      next(error);
    }
  }

  async analyzeLinks(req: Request, res: Response, next: NextFunction) {
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

      try {
        const links = await structureAnalyzerService.getLinksOnly(parsedPdf);

        res.json({
          success: true,
          data: {
            totalLinks: links.length,
            linksWithDescriptiveText: links.filter(l => l.hasDescriptiveText).length,
            linksWithIssues: links.filter(l => l.issues.length > 0).length,
            links,
          },
        });
      } finally {
        await pdfParserService.close(parsedPdf);
      }
    } catch (error) {
      next(error);
    }
  }
}

export const pdfController = new PdfController();
