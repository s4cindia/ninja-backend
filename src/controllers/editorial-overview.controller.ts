import { Request, Response, NextFunction } from 'express';
import mammoth from 'mammoth';
import path from 'path';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { sanitizeDocumentHtml } from '../utils/html-sanitizer';

export class EditorialOverviewController {
  async getDocumentOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          job: {
            select: {
              id: true,
              type: true,
              status: true,
              createdAt: true,
              completedAt: true,
              error: true,
            },
          },
          _count: {
            select: {
              citations: true,
              citationValidations: true,
              citationChanges: true,
              referenceListEntries: true,
            },
          },
        },
      });

      if (!document) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      const [creationJob, outputLinkedJobs] = await Promise.all([
        prisma.job.findUnique({
          where: { id: document.jobId },
          select: {
            id: true,
            type: true,
            status: true,
            createdAt: true,
            completedAt: true,
            error: true,
          },
        }),
        prisma.$queryRaw<Array<{
          id: string;
          type: string;
          status: string;
          createdAt: Date;
          completedAt: Date | null;
          error: string | null;
        }>>`
          SELECT id, type, status, "createdAt", "completedAt", error
          FROM "Job"
          WHERE "tenantId" = ${tenantId}
            AND id != ${document.jobId}
            AND output->>'documentId' = ${documentId}
          ORDER BY "createdAt" DESC
        `,
      ]);

      const documentJobs = [
        ...(creationJob ? [creationJob] : []),
        ...outputLinkedJobs,
      ];

      const jobLinks = documentJobs.map((job) => ({
        jobId: job.id,
        type: job.type,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        error: job.error,
        url: `/api/v1/jobs/${job.id}`,
      }));

      const latestValidation = await prisma.citationValidation.findFirst({
        where: { documentId },
        orderBy: { createdAt: 'desc' },
        select: { styleCode: true, createdAt: true },
      });

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            fileName: document.originalName || document.fileName,
            mimeType: document.mimeType,
            fileSize: document.fileSize,
            wordCount: document.wordCount,
            pageCount: document.pageCount,
            title: document.title,
            authors: document.authors,
            language: document.language,
            status: document.status,
            parsedAt: document.parsedAt,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            referenceListStatus: document.referenceListStatus,
            referenceListStyle: document.referenceListStyle,
            referenceListGeneratedAt: document.referenceListGeneratedAt,
          },
          counts: {
            citations: document._count.citations,
            validations: document._count.citationValidations,
            corrections: document._count.citationChanges,
            referenceEntries: document._count.referenceListEntries,
          },
          lastValidation: latestValidation
            ? {
                styleCode: latestValidation.styleCode,
                validatedAt: latestValidation.createdAt,
              }
            : null,
          jobs: jobLinks,
          links: {
            stylesheetAnalysis: `/api/v1/citation/document/${documentId}`,
            citationsWithComponents: `/api/v1/citation/document/${documentId}/with-components`,
            stats: `/api/v1/citation/document/${documentId}/stats`,
            validate: `/api/v1/citation/document/${documentId}/validate`,
            validations: `/api/v1/citation/document/${documentId}/validations`,
            referenceList: `/api/v1/citation/document/${documentId}/reference-list`,
            corrections: `/api/v1/citation/document/${documentId}/changes`,
            redetect: `/api/v1/citation/document/${documentId}/redetect`,
          },
        },
      });
    } catch (error) {
      logger.error('[Editorial Overview] getDocumentOverview failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async listDocuments(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.user?.tenantId;
      const { status, limit = '20', offset = '0' } = req.query;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const where: Record<string, unknown> = { tenantId };
      if (status) where.status = status;

      const [documents, total] = await Promise.all([
        prisma.editorialDocument.findMany({
          where,
          select: {
            id: true,
            jobId: true,
            originalName: true,
            fileName: true,
            mimeType: true,
            fileSize: true,
            wordCount: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            referenceListStatus: true,
            _count: {
              select: {
                citations: true,
                citationValidations: true,
                referenceListEntries: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: Math.min(parseInt(limit as string) || 20, 100),
          skip: parseInt(offset as string) || 0,
        }),
        prisma.editorialDocument.count({ where }),
      ]);

      res.json({
        success: true,
        data: {
          documents: documents.map((doc) => ({
            id: doc.id,
            jobId: doc.jobId,
            fileName: doc.originalName || doc.fileName,
            mimeType: doc.mimeType,
            fileSize: doc.fileSize,
            wordCount: doc.wordCount,
            status: doc.status,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            referenceListStatus: doc.referenceListStatus,
            counts: {
              citations: doc._count.citations,
              validations: doc._count.citationValidations,
              referenceEntries: doc._count.referenceListEntries,
            },
            links: {
              overview: `/api/v1/editorial/document/${doc.id}/overview`,
              job: `/api/v1/jobs/${doc.jobId}`,
            },
          })),
          total,
          limit: Math.min(parseInt(limit as string) || 20, 100),
          offset: parseInt(offset as string) || 0,
        },
      });
    } catch (error) {
      logger.error('[Editorial Overview] listDocuments failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
  async getDocumentText(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      let document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, fullText: true, fullHtml: true },
      });

      if (!document) {
        document = await prisma.editorialDocument.findFirst({
          where: { jobId: documentId, tenantId },
          select: { id: true, fullText: true, fullHtml: true },
        });
      }

      if (!document) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          documentId: document.id,
          fullText: document.fullText || null,
          fullHtml: document.fullHtml || null,
        },
      });
    } catch (error) {
      logger.error('[Editorial Overview] getDocumentText failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async regenerateHtml(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No file uploaded. Send DOCX as multipart/form-data with field name "file".' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext !== '.docx') {
        res.status(415).json({ success: false, error: 'Only .docx files are supported for HTML generation.' });
        return;
      }

      let document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, fileName: true },
      });

      if (!document) {
        document = await prisma.editorialDocument.findFirst({
          where: { jobId: documentId, tenantId },
          select: { id: true, fileName: true },
        });
      }

      if (!document) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      const result = await mammoth.convertToHtml({ buffer: req.file.buffer }, {
        styleMap: [
          "p[style-name='Title'] => h1.doc-title",
          "p[style-name='Heading 1'] => h1",
          "p[style-name='Heading 2'] => h2",
          "p[style-name='Heading 3'] => h3",
          "p[style-name='Heading 4'] => h4",
          "b => strong",
          "i => em",
          "u => u",
          "strike => s",
        ],
      });

      const sanitizedHtml = sanitizeDocumentHtml(result.value);

      await prisma.editorialDocument.update({
        where: { id: document.id },
        data: { fullHtml: sanitizedHtml },
      });

      logger.info(`[Editorial Overview] Regenerated HTML for document ${document.id} (${result.value.length} chars)`);

      res.json({
        success: true,
        data: {
          documentId: document.id,
          htmlLength: result.value.length,
          warnings: result.messages.length,
        },
      });
    } catch (error) {
      logger.error('[Editorial Overview] regenerateHtml failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const editorialOverviewController = new EditorialOverviewController();
