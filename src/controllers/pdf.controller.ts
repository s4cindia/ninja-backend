import { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { Prisma, FileStatus } from '@prisma/client';
import fs from 'fs/promises';
import { validateFilePath } from '../utils/path-validator';
import { pdfParserService } from '../services/pdf/pdf-parser.service';
import { textExtractorService } from '../services/pdf/text-extractor.service';
import { imageExtractorService } from '../services/pdf/image-extractor.service';
import { structureAnalyzerService } from '../services/pdf/structure-analyzer.service';
import { pdfAuditService } from '../services/pdf/pdf-audit.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { reScanJobSchema } from '../schemas/pdf.schemas';
import { workflowService } from '../services/workflow/workflow.service';
import { workflowConfigService } from '../services/workflow/workflow-config.service';

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
          data: {},
          error: {
            code: 'PDF_FILE_MISSING',
            message: 'No PDF file uploaded',
            details: 'Request must include a PDF file in multipart/form-data format',
          },
        });
      }

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          data: {},
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Authentication required',
            details: 'Valid tenant and user credentials are required',
          },
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
          output: JSON.parse(JSON.stringify({
            fileName: req.file.originalname,
            auditReport: result,
            scanLevel: 'basic', // Default to basic scan
          })) as Prisma.InputJsonObject,
        },
      });

      // Create an initial AcrJob record so this PDF audit appears in the ACR workflow.
      // Multiple AcrJob records per jobId are intentional: finalized reports are preserved
      // as version history and subsequent edits produce new draft records.
      try {
        await prisma.acrJob.create({
          data: {
            jobId: job.id,
            tenantId,
            userId,
            edition: 'WCAG21-AA',
            documentTitle: req.file.originalname,
            documentType: 'PDF',
            status: 'draft',
          },
        });
      } catch (acrErr) {
        logger.warn('[PDF Audit] Failed to create AcrJob record (non-fatal)', acrErr instanceof Error ? acrErr.message : String(acrErr));
      }

      // ═══════════════════════════════════════════════════════════════
      // 🔄 Sprint 9: Create File record and Workflow for this PDF
      // ═══════════════════════════════════════════════════════════════
      let workflowId: string | undefined;
      try {
        // Create a File record for this PDF (needed for workflow)
        const storagePath = process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage';
        const fileRecord = await prisma.file.create({
          data: {
            id: nanoid(),
            tenantId,
            filename: `${nanoid()}_${req.file.originalname}`,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype || 'application/pdf',
            size: req.file.size,
            path: `${storagePath}/${job.id}/${req.file.originalname}`,
            status: 'UPLOADED',
          },
        });
        logger.info(`[PDF Controller] Created File record ${fileRecord.id} for job ${job.id}`);

        // Check if workflow is enabled for this tenant
        const shouldCreate = await workflowConfigService.shouldCreateWorkflow(tenantId);

        if (shouldCreate) {
          // Create workflow for this file
          const workflow = await workflowService.createWorkflow(fileRecord.id, userId);
          workflowId = workflow.id;
          logger.info(`[PDF Controller] Workflow created: ${workflowId}, state: ${workflow.currentState}`);
        } else {
          logger.info(`[PDF Controller] Workflow disabled for tenant ${tenantId}, skipping creation`);
        }
      } catch (workflowError) {
        // Don't fail the PDF audit if workflow creation fails
        logger.error(`[PDF Controller] Failed to create workflow for job ${job.id}`, workflowError);
      }

      return res.status(200).json({
        success: true,
        data: {
          jobId: job.id,
          fileName: req.file.originalname,
          auditReport: result,
          workflowId, // Include workflow ID in response
        },
      });
    } catch (error) {
      logger.error('PDF audit from buffer failed:', error instanceof Error ? error : undefined);

      if (jobId) {
        try {
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              completedAt: new Date(),
              output: {
                error: error instanceof Error ? error.message : 'Unknown error',
              },
            },
          });
        } catch (updateError) {
          logger.error('Failed to update job status to FAILED:', updateError instanceof Error ? updateError : undefined);
        }
      }

      const errorMessage = error instanceof Error ? error.message : 'Failed to audit PDF';
      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'PDF_AUDIT_FAILED',
          message: errorMessage,
          details: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  }

  async reScanJob(req: AuthenticatedRequest, res: Response) {
    try {
      // Validate route params
      const paramsValidation = reScanJobSchema.params.safeParse(req.params);
      if (!paramsValidation.success) {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request parameters',
            details: paramsValidation.error.issues,
          },
        });
      }

      // Validate request body
      const bodyValidation = reScanJobSchema.body.safeParse(req.body);
      if (!bodyValidation.success) {
        return res.status(400).json({
          success: false,
          data: {},
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: bodyValidation.error.issues,
          },
        });
      }

      const { jobId } = paramsValidation.data;
      const { scanLevel, customValidators } = bodyValidation.data;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          data: {},
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            details: null,
          },
        });
      }

      // Verify job exists and belongs to user's tenant
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId,
        },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          data: {},
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
        });
      }

      // Get the original file
      const jobInput = job.input as { fileName?: string } | null;
      const fileName = jobInput?.fileName || 'document.pdf';
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
          output: JSON.parse(JSON.stringify({
            fileName,
            auditReport: result,
            scanLevel,
          })) as Prisma.InputJsonObject,
        },
      });
      logger.info(`[reScanJob] Database updated for job ${jobId}. Status: ${updatedJob.status}`);

      // Ensure an AcrJob record exists so the re-scanned PDF appears in the ACR workflow.
      // Multiple AcrJob records per jobId are intentional (finalized reports are versioned).
      // This creates one only when none exists. The non-atomic findFirst+create pattern is
      // shared with the EPUB acr.service.ts implementation; a concurrent race would at most
      // produce an extra draft record, which is non-fatal and caught below.
      try {
        const existingAcrJob = await prisma.acrJob.findFirst({ where: { jobId } });
        if (!existingAcrJob) {
          await prisma.acrJob.create({
            data: {
              jobId,
              tenantId,
              userId: job.userId,
              edition: 'WCAG21-AA',
              documentTitle: fileName,
              documentType: 'PDF',
              status: 'draft',
            },
          });
        }
      } catch (acrErr) {
        logger.warn('[reScanJob] Failed to upsert AcrJob record (non-fatal)', acrErr instanceof Error ? acrErr.message : String(acrErr));
      }

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

      // Mark job as FAILED before returning error
      const jobId = req.params.jobId;
      if (jobId) {
        try {
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              completedAt: new Date(),
              output: {
                error: error instanceof Error ? error.message : 'Unknown error',
              },
            },
          });
        } catch (updateError) {
          logger.error('Failed to update job status to FAILED:', updateError instanceof Error ? updateError : undefined);
        }
      }

      const errorMessage = error instanceof Error ? error.message : 'Failed to re-scan PDF';
      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'PDF_RESCAN_FAILED',
          message: errorMessage,
          details: error instanceof Error ? error.stack : null,
        },
      });
    }
  }

  async getAuditResult(req: Request, res: Response) {
    try {
      const job = req.job;

      if (!job) {
        return res.status(404).json({
          success: false,
          data: null,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found or access denied',
            details: null,
          },
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

      // Check if job is COMPLETED but auditReport is missing
      if (job.status === 'COMPLETED' && !auditReport) {
        return res.status(404).json({
          success: false,
          data: {},
          error: {
            code: 'AUDIT_REPORT_NOT_FOUND',
            message: 'Audit report not found for completed job',
            details: null,
          },
        });
      }

      return res.json({
        success: true,
        data: auditReport,
      });
    } catch (error) {
      logger.error('Failed to get PDF audit result:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to retrieve audit result';
      return res.status(500).json({
        success: false,
        data: {},
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
          details: error instanceof Error ? error.stack : null,
        },
      });
    }
  }

  async auditFromFileId(req: AuthenticatedRequest, res: Response) {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.id;
    const { fileId } = req.body;
    let previousFileStatus: FileStatus | null = null;

    try {
      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      if (!fileId) {
        return res.status(400).json({
          success: false,
          error: 'fileId is required',
        });
      }

      // Atomically update file status from UPLOADED to PROCESSING
      const atomicUpdate = await prisma.file.updateMany({
        where: {
          id: fileId,
          tenantId,
          status: 'UPLOADED',
        },
        data: { status: 'PROCESSING' },
      });

      if (atomicUpdate.count === 0) {
        const existingFile = await prisma.file.findFirst({
          where: { id: fileId, tenantId },
        });

        if (!existingFile) {
          return res.status(404).json({
            success: false,
            error: 'File not found',
          });
        }

        return res.status(400).json({
          success: false,
          error: `File not ready for processing. Status: ${existingFile.status}`,
        });
      }

      previousFileStatus = FileStatus.UPLOADED;

      const fileRecord = await prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!fileRecord) {
        await prisma.file.update({
          where: { id: fileId },
          data: { status: FileStatus.UPLOADED },
        }).catch(() => {});
        return res.status(500).json({
          success: false,
          error: 'File record not found after update',
        });
      }

      const job = await prisma.job.create({
        data: {
          id: nanoid(),
          tenantId,
          userId,
          type: 'PDF_ACCESSIBILITY',
          status: 'QUEUED',
          input: {
            fileId: fileRecord.id,
            fileName: fileRecord.originalName,
            mimeType: fileRecord.mimeType,
            size: fileRecord.size,
            storageType: fileRecord.storageType,
            storagePath: fileRecord.storagePath,
          },
          updatedAt: new Date(),
        },
      });

      res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          status: 'QUEUED',
          message: 'Audit job queued. Poll GET /api/v1/jobs/:jobId for status.',
        },
      });

      processPdfAuditInBackground(job.id, fileRecord).catch((error) => {
        logger.error(`Background PDF audit failed for job ${job.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });

    } catch (error) {
      logger.error(`PDF audit from fileId failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Roll back file status when request handler fails
      if (previousFileStatus) {
        await prisma.file.update({
          where: { id: fileId },
          data: { status: previousFileStatus },
        }).catch(() => {});
      }

      return res.status(500).json({
        success: false,
        error: 'PDF audit failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

async function processPdfAuditInBackground(
  jobId: string,
  file: { id: string; originalName: string; storageType: string; storagePath: string | null; path: string | null }
): Promise<void> {
  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    // Get file buffer with proper null checks
    let fileBuffer: Buffer;
    if (file.storageType === 'S3' && file.storagePath) {
      logger.info(`Background: Fetching PDF from S3: ${file.storagePath}`);
      fileBuffer = await s3Service.getFileBuffer(file.storagePath);
    } else if (file.path) {
      logger.info(`Background: Reading PDF from local path: ${file.path}`);
      fileBuffer = await fs.readFile(file.path);
    } else {
      throw new Error('No valid file path available (neither S3 nor local)');
    }

    await fileStorageService.saveFile(jobId, file.originalName, fileBuffer);

    const result = await pdfAuditService.runAuditFromBuffer(
      fileBuffer,
      jobId,
      file.originalName
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        output: JSON.parse(JSON.stringify({
          fileName: file.originalName,
          auditReport: result,
          scanLevel: 'basic',
        })) as Prisma.InputJsonObject,
        completedAt: new Date(),
      },
    });

    await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.PROCESSED },
    });

    logger.info(`Background PDF audit completed for job ${jobId}`);
  } catch (error) {
    logger.error(`PDF audit processing failed for job ${jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`);

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      },
    }).catch(() => {});

    await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.ERROR },
    }).catch(() => {});
  }
}

export const pdfController = new PdfController();
