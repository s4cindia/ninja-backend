import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { getCalibrationQueue } from '../queues';
import prisma from '../lib/prisma';
import { getCorpusStats } from '../services/calibration/corpus-stats.service';

const router = Router();

const runBodySchema = z.object({
  documentId: z.string().min(1),
  fileId: z.string().min(1),
});

// POST /api/v1/calibration/run
router.post('/run', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = runBodySchema.safeParse(req.body);
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

    const { documentId, fileId } = parsed.data;
    const tenantId = req.user!.tenantId;

    const queue = getCalibrationQueue();
    if (!queue) {
      return res.status(503).json({
        success: false,
        error: { code: 'QUEUE_UNAVAILABLE', message: 'Calibration queue not available' },
      });
    }

    await queue.add('run-calibration', {
      type: 'CALIBRATION' as never,
      tenantId,
      userId: req.user!.id,
      options: { documentId, tenantId, fileId },
    });

    return res.status(202).json({
      success: true,
      data: { status: 'queued', message: 'Calibration job enqueued' },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const runsQuerySchema = z.object({
  documentId: z.string().optional(),
  limit: z.coerce.number().optional(),
  fromDate: z.string().datetime({ offset: true }).optional(),
  toDate: z.string().datetime({ offset: true }).optional(),
});

// GET /api/v1/calibration/runs
router.get('/runs', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = runsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { documentId, limit, fromDate, toDate } = parsed.data;
    const take = Math.min(limit || 20, 100);

    const where: Record<string, unknown> = {};
    if (documentId) {
      where.documentId = documentId;
    }
    if (fromDate) {
      where.runDate = { ...((where.runDate as Record<string, unknown>) || {}), gte: new Date(fromDate) };
    }
    if (toDate) {
      where.runDate = { ...((where.runDate as Record<string, unknown>) || {}), lte: new Date(toDate) };
    }

    const runs = await prisma.calibrationRun.findMany({
      where,
      select: {
        id: true,
        documentId: true,
        runDate: true,
        completedAt: true,
        durationMs: true,
        greenCount: true,
        amberCount: true,
        redCount: true,
        summary: true,
      },
      orderBy: { runDate: 'desc' },
      take,
    });

    return res.json({ success: true, data: runs });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/calibration/runs/:runId
router.get('/runs/:runId', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    return res.json({ success: true, data: run });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// DELETE /api/v1/calibration/runs/:runId (soft delete)
router.delete('/runs/:runId', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    await prisma.calibrationRun.update({
      where: { id: runId },
      data: { isArchived: true },
    });

    return res.json({ message: 'CalibrationRun archived' });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const zonesQuerySchema = z.object({
  bucket: z.enum(['GREEN', 'AMBER', 'RED']).optional(),
  limit: z.coerce.number().default(50),
  cursor: z.string().optional(),
});

// GET /api/v1/calibration/runs/:runId/zones
router.get('/runs/:runId/zones', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const parsed = zonesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { bucket, limit, cursor } = parsed.data;

    const where: Record<string, unknown> = { calibrationRunId: runId };
    if (bucket) {
      where.reconciliationBucket = bucket;
    }

    const zones = await prisma.zone.findMany({
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: 'asc' },
    });

    let nextCursor: string | undefined;
    if (zones.length > limit) {
      const extra = zones.pop()!;
      nextCursor = extra.id;
    }

    return res.json({ success: true, data: zones, nextCursor });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const corpusDocsQuerySchema = z.object({
  limit: z.coerce.number().default(20),
  cursor: z.string().optional(),
  publisher: z.string().optional(),
  contentType: z.string().optional(),
});

// GET /api/v1/calibration/corpus-docs
router.get('/corpus-docs', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = corpusDocsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { limit, cursor, publisher, contentType } = parsed.data;
    const take = Math.min(limit, 100);

    const where: Record<string, unknown> = {};
    if (publisher) where.publisher = publisher;
    if (contentType) where.contentType = contentType;

    const documents = await prisma.corpusDocument.findMany({
      where,
      take: take + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { uploadedAt: 'desc' },
      include: {
        bootstrapJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    let nextCursor: string | null = null;
    if (documents.length > take) {
      const extra = documents.pop()!;
      nextCursor = extra.id;
    }

    return res.json({
      success: true,
      data: { documents, nextCursor },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/calibration/corpus-stats
router.get('/corpus-stats', authenticate, async (_req: Request, res: Response) => {
  try {
    const stats = await getCorpusStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
