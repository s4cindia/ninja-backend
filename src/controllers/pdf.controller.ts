import { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { validateFilePath } from '../utils/path-validator';
import { pdfParserService } from '../services/pdf/pdf-parser.service';
import { textExtractorService } from '../services/pdf/text-extractor.service';
import { imageExtractorService } from '../services/pdf/image-extractor.service';
import { structureAnalyzerService } from '../services/pdf/structure-analyzer.service';
import { pdfAuditService } from '../services/pdf/pdf-audit.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { AuthenticatedRequest } from '../types/authenticated-request';

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

  async auditFromBuffer(req: AuthenticatedRequest, res: Response) {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.id;
    let jobId: string | undefined;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No PDF file uploaded',
        });
      }

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const job = await prisma.job.create({
        data: {
          id: nanoid(),
          tenantId,
          userId,
          type: 'PDF_ACCESSIBILITY',
          status: 'PROCESSING',
          input: {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      jobId = job.id;

      await fileStorageService.saveFile(job.id, req.file.originalname, req.file.buffer);

      const result = await pdfAuditService.runAuditFromBuffer(
        req.file.buffer,
        job.id,
        req.file.originalname
      );

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: {
            fileName: req.file.originalname,
            auditReport: result,
            scanLevel: 'basic', // Default to basic scan
          } as any,
        },
      });

      return res.status(200).json({
        success: true,
        data: {
          jobId: job.id,
          fileName: req.file.originalname,
          auditReport: result,
        },
      });
    } catch (error) {
      logger.error('PDF audit from buffer failed:', error instanceof Error ? error : undefined);

      if (jobId) {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            output: {
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          },
        }).catch(updateError => {
          logger.error('Failed to update job status to FAILED:', updateError instanceof Error ? updateError : undefined);
        });
      }

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to audit PDF',
      });
    }
  }

  async reScanJob(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;
      const { scanLevel = 'comprehensive', customValidators } = req.body;
      const job = (req as any).job;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      // Validate scan level
      if (!['basic', 'comprehensive', 'custom'].includes(scanLevel)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid scan level. Must be basic, comprehensive, or custom',
        });
      }

      // Get the original file
      const fileName = job.input?.fileName || 'document.pdf';
      const buffer = await fileStorageService.getFile(jobId, fileName);

      if (!buffer) {
        return res.status(404).json({
          success: false,
          error: 'PDF file not found',
        });
      }

      // Update job to processing
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Re-run audit with new scan level
      logger.info(`[reScanJob] Starting audit for job ${jobId} with scan level: ${scanLevel}`);
      const result = await pdfAuditService.runAuditFromBuffer(
        buffer,
        jobId,
        fileName,
        scanLevel,
        customValidators
      );
      logger.info(`[reScanJob] Audit completed for job ${jobId}. Updating database to COMPLETED...`);

      // Update job with new results
      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: {
            fileName,
            auditReport: result,
            scanLevel,
          } as any,
        },
      });
      logger.info(`[reScanJob] Database updated for job ${jobId}. Status: ${updatedJob.status}`);

      return res.status(200).json({
        success: true,
        data: {
          jobId,
          scanLevel,
          auditReport: result,
        },
      });
    } catch (error) {
      logger.error('PDF re-scan failed:', error instanceof Error ? error : undefined);

      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to re-scan PDF',
      });
    }
  }

  async getAuditResult(req: Request, res: Response) {
    try {
      const job = (req as any).job;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found or access denied',
        });
      }

      if (job.status !== 'COMPLETED') {
        return res.json({
          success: true,
          data: {
            status: job.status,
            message: job.status === 'PROCESSING' ? 'Audit in progress' : 'Audit not started',
          },
        });
      }

      const input = job.input as Record<string, unknown> | null;
      const output = job.output as Record<string, unknown> | null;
      const auditReport = output?.auditReport as Record<string, unknown> | undefined;

      // Extract additional data from metadata and job
      if (auditReport) {
        const metadata = auditReport.metadata as Record<string, unknown> | undefined;
        const matterhornSummary = metadata?.matterhornSummary;

        // Extract page count from metadata
        const pageCount = (metadata?.pageCount as number) || (auditReport.pageCount as number) || 1;

        // Debug: Log sample issues to check if pageNumber is present
        const issues = auditReport.issues as Array<Record<string, unknown>> | undefined;
        if (issues && issues.length > 0) {
          logger.debug(`[DEBUG] Total issues: ${issues.length}`);
          logger.debug(`[DEBUG] First issue: ${JSON.stringify(issues[0], null, 2)}`);

          // Find and log an alt-text issue
          const altTextIssue = issues.find(i => i.source === 'pdf-alttext');
          if (altTextIssue) {
            logger.debug(`[DEBUG] Sample alt-text issue: ${JSON.stringify(altTextIssue, null, 2)}`);
          }

          // Find and log a table issue
          const tableIssue = issues.find(i => i.source === 'pdf-table');
          if (tableIssue) {
            logger.debug(`[DEBUG] Sample table issue: ${JSON.stringify(tableIssue, null, 2)}`);
          }
        }

        return res.json({
          success: true,
          data: {
            id: job.id,
            jobId: job.id,
            fileName: input?.fileName || output?.fileName || auditReport.fileName || 'Unknown',
            fileSize: input?.size || 0,
            pageCount,
            status: 'completed',
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            scanLevel: output?.scanLevel || 'basic', // Include scan level
            ...auditReport,
            matterhornSummary,
          },
        });
      }

      return res.json({
        success: true,
        data: auditReport,
      });
    } catch (error) {
      logger.error('Failed to get PDF audit result:', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit result',
      });
    }
  }
}

export const pdfController = new PdfController();
