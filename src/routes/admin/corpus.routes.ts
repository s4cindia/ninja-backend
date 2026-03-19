import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import {
  generateUploadUrl,
  registerCorpusDocument,
  listCorpusDocuments,
} from '../../services/corpus/corpus-upload.service';
import prisma from '../../lib/prisma';
import { getCalibrationQueue, JOB_TYPES, areQueuesAvailable } from '../../queues';
import { logger } from '../../lib/logger';

const router = Router();

const isAdmin = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return role === 'admin' || role === 'ADMIN';
};

const uploadUrlBodySchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/pdf'),
});

// POST /api/v1/admin/corpus/upload-url
router.post('/corpus/upload-url', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = uploadUrlBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { filename, contentType } = parsed.data;
    const result = await generateUploadUrl(filename, contentType);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const registerBodySchema = z.object({
  filename: z.string().min(1),
  s3Path: z.string().min(1),
  publisher: z.string().optional(),
  contentType: z.string().optional(),
  pageCount: z.coerce.number().optional(),
  language: z.string().default('en'),
});

// POST /api/v1/admin/corpus/register
router.post('/corpus/register', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const doc = await registerCorpusDocument(parsed.data);
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const documentsQuerySchema = z.object({
  limit: z.coerce.number().default(20),
  cursor: z.string().optional(),
  publisher: z.string().optional(),
  contentType: z.string().optional(),
});

// GET /api/v1/admin/corpus/documents
router.get('/corpus/documents', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = documentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const result = await listCorpusDocuments(parsed.data);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/admin/corpus/documents/:id/run
router.post('/corpus/documents/:id/run', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const { id } = req.params;

    const doc = await prisma.corpusDocument.findUnique({
      where: { id },
    });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    // Check for in-progress run (completedAt is null means still running)
    const existing = await prisma.calibrationRun.findFirst({
      where: {
        documentId: id,
        completedAt: null,
      },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'RUN_IN_PROGRESS',
          message: 'A calibration run is already in progress',
        },
      });
    }

    // Optional: operator-uploaded pdfxt-tagged PDF path
    const taggedPdfPath = typeof req.body?.taggedPdfPath === 'string' && req.body.taggedPdfPath.length > 0
      ? req.body.taggedPdfPath
      : undefined;

    const run = await prisma.calibrationRun.create({
      data: {
        documentId: id,
      },
    });

    // Dispatch BullMQ calibration job
    const reqUser = (req as Request & { user?: { tenantId?: string; userId?: string; id?: string } }).user;
    const tenantId = reqUser?.tenantId ?? '';
    const userId = reqUser?.userId ?? reqUser?.id ?? '';

    if (areQueuesAvailable()) {
      const queue = getCalibrationQueue();
      if (queue) {
        await queue.add(JOB_TYPES.CALIBRATION_RUN, {
          type: JOB_TYPES.CALIBRATION_RUN,
          tenantId,
          userId,
          options: {
            runId: run.id,
            documentId: id,
            s3Path: doc.s3Path,
            tenantId,
            ...(taggedPdfPath ? { taggedPdfPath } : {}),
          },
        }, {
          jobId: `calibration-${run.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        logger.info(`[CorpusRun] Dispatched calibration job for run ${run.id}`);
      } else {
        logger.warn(`[CorpusRun] Calibration queue not available — run ${run.id} will not be processed`);
      }
    } else {
      logger.warn(`[CorpusRun] Redis not configured — run ${run.id} will not be processed`);
    }

    return res.status(202).json({
      success: true,
      data: { runId: run.id, documentId: id, status: 'QUEUED' },
    });
  } catch (err) {
    logger.error('POST /admin/corpus/documents/:id/run error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

export default router;
