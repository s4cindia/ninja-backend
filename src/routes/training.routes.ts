import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';
import { startTraining, onTrainingComplete } from '../services/training/training.service';

const router = Router();

const groundTruthQuerySchema = z.object({
  runId: z.string().min(1),
});

// GET /api/v1/training/ground-truth
router.get('/ground-truth', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = groundTruthQuerySchema.safeParse(req.query);
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

    const { runId } = parsed.data;

    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId: runId,
        operatorVerified: true,
        isArtefact: false,
      },
    });

    const mappedZones = zones.map((zone) => ({
      pageNumber: zone.pageNumber,
      bbox: zone.bounds,
      label: zone.operatorLabel ?? zone.type,
      confidence: 1.0,
      source: 'operator' as const,
    }));

    return res.json({
      success: true,
      data: { zones: mappedZones, total: mappedZones.length },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/training/ground-truth/stats
router.get('/ground-truth/stats', authenticate, async (req: Request, res: Response) => {
  try {
    const confirmedZones = await prisma.zone.findMany({
      where: { operatorVerified: true, isArtefact: false },
      select: { operatorLabel: true, type: true, calibrationRunId: true },
    });

    const totalConfirmed = confirmedZones.length;

    // Group by zone type
    const byZoneType: Record<string, number> = {};
    for (const zone of confirmedZones) {
      const label = zone.operatorLabel ?? zone.type;
      byZoneType[label] = (byZoneType[label] ?? 0) + 1;
    }

    // Group by publisher via CalibrationRun → CorpusDocument
    const runIds = [...new Set(confirmedZones.map((z) => z.calibrationRunId).filter(Boolean))] as string[];
    const byPublisher: Record<string, number> = {};

    if (runIds.length > 0) {
      const runs = await prisma.calibrationRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, corpusDocument: { select: { publisher: true } } },
      });

      const runPublisherMap = new Map<string, string | null>();
      for (const run of runs) {
        runPublisherMap.set(run.id, run.corpusDocument.publisher);
      }

      for (const zone of confirmedZones) {
        if (!zone.calibrationRunId) continue;
        const publisher = runPublisherMap.get(zone.calibrationRunId);
        if (publisher != null) {
          byPublisher[publisher] = (byPublisher[publisher] ?? 0) + 1;
        }
      }
    }

    return res.json({
      success: true,
      data: { totalConfirmed, byZoneType, byPublisher },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const startTrainingBodySchema = z.object({
  corpusExportS3Path: z.string().min(1),
  modelVariant: z.enum(['yolov8m', 'yolov8n', 'yolov8l']).default('yolov8m'),
});

// POST /api/v1/training/start
router.post('/start', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = startTrainingBodySchema.safeParse(req.body);
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

    const { corpusExportS3Path, modelVariant } = parsed.data;
    const trainingRunId = await startTraining({ corpusExportS3Path, modelVariant });

    return res.status(202).json({
      success: true,
      data: { trainingRunId, status: 'RUNNING' },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const completeBodySchema = z.object({
  trainingRunId: z.string().min(1),
  success: z.boolean(),
  resultData: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/v1/training/complete (ECS webhook)
router.post('/complete', async (req: Request, res: Response) => {
  try {
    if (process.env.TRAINING_WEBHOOK_SECRET) {
      const secret = req.headers['x-training-secret'];
      if (secret !== process.env.TRAINING_WEBHOOK_SECRET) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid webhook secret' },
        });
      }
    }

    const parsed = completeBodySchema.safeParse(req.body);
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

    const { trainingRunId, success, resultData } = parsed.data;
    await onTrainingComplete(trainingRunId, success, resultData);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const runsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().default(20),
});

// GET /api/v1/training/runs
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

    const { status, limit } = parsed.data;
    const runs = await prisma.trainingRun.findMany({
      where: status ? { status } : undefined,
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 100),
    });

    return res.json({ success: true, data: { runs } });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/training/runs/:id
router.get('/runs/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const run = await prisma.trainingRun.findUnique({
      where: { id: req.params.id },
    });

    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `TrainingRun ${req.params.id} not found` },
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

// GET /api/v1/training/learning-curve
router.get('/learning-curve', authenticate, async (_req: Request, res: Response) => {
  try {
    const runs = await prisma.trainingRun.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { completedAt: 'asc' },
      select: { id: true, completedAt: true, corpusSize: true, mapResult: true },
    });

    const curve = runs.map((run) => ({
      runId: run.id,
      date: run.completedAt,
      corpusSize: run.corpusSize,
      overallMAP: (run.mapResult as Record<string, unknown>)?.overallMAP ?? null,
    }));

    return res.json({ success: true, data: curve });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
