import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { getCalibrationQueue } from '../queues';
import prisma from '../lib/prisma';

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

// GET /api/v1/calibration/runs
router.get('/runs', authenticate, async (req: Request, res: Response) => {
  try {
    const { documentId, limit } = req.query;
    const take = Math.min(Number(limit) || 20, 100);

    const where: Record<string, unknown> = {};
    if (documentId && typeof documentId === 'string') {
      where.documentId = documentId;
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

export default router;
