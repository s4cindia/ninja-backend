import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';
import { startTraining, onTrainingComplete } from '../services/training/training.service';
import { evaluateTrainingRun, promoteTrainingRun, rollbackTrainingRun } from '../services/training/evaluation.service';
import { AuthenticatedRequest } from '../types/authenticated-request';

const s3Client = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });

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

const completeBodySchema = z.discriminatedUnion('success', [
  z.object({
    trainingRunId: z.string().min(1),
    success: z.literal(true),
    resultData: z.object({
      weightsS3: z.string().min(1),
      onnxS3: z.string().min(1),
      epochs: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      overallMAP: z.number().optional(),
      perClassAP: z.record(z.string(), z.number()).optional(),
    }),
  }),
  z.object({
    trainingRunId: z.string().min(1),
    success: z.literal(false),
    resultData: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// POST /api/v1/training/complete (ECS webhook)
router.post('/complete', async (req: Request, res: Response) => {
  try {
    if (!process.env.TRAINING_WEBHOOK_SECRET) {
      return res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Webhook secret not configured' },
      });
    }
    const secret = req.headers['x-training-secret'];
    if (secret !== process.env.TRAINING_WEBHOOK_SECRET) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid webhook secret' },
      });
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

const exportBodySchema = z.object({
  runIds: z.array(z.string().min(1)).min(1),
  exportId: z.string().optional(),
});

// POST /api/v1/training/export
router.post('/export', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = exportBodySchema.safeParse(req.body);
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

    const { runIds } = parsed.data;
    const exportId = parsed.data.exportId ?? randomUUID();

    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId: { in: runIds },
        operatorVerified: true,
        isArtefact: false,
      },
      include: {
        calibrationRun: {
          include: { corpusDocument: true },
        },
      },
    });

    // Group zones by CorpusDocument
    const byDocument = new Map<string, { doc: NonNullable<typeof zones[0]['calibrationRun']>['corpusDocument']; zones: typeof zones }>();
    for (const zone of zones) {
      if (!zone.calibrationRun) continue;
      const doc = zone.calibrationRun.corpusDocument;
      if (!byDocument.has(doc.id)) {
        byDocument.set(doc.id, { doc, zones: [] });
      }
      byDocument.get(doc.id)!.zones.push(zone);
    }

    // Build ground truth payload
    const documents = Array.from(byDocument.values()).map(({ doc, zones: docZones }) => ({
      documentId: doc.id,
      pdfPath: doc.s3Path,
      publisher: doc.publisher,
      contentType: doc.contentType,
      zones: docZones.map((z) => ({
        pageNumber: z.pageNumber,
        bounds: z.bounds,
        type: z.type,
        operatorLabel: z.operatorLabel,
      })),
    }));

    const groundTruthS3Path = `s3://ninja-training-exports/${exportId}/ground_truth.json`;

    // Upload ground truth JSON to S3
    const groundTruthPayload = JSON.stringify({ documents }, null, 2);
    await s3Client.send(new PutObjectCommand({
      Bucket: 'ninja-training-exports',
      Key: `${exportId}/ground_truth.json`,
      Body: groundTruthPayload,
      ContentType: 'application/json',
    }));

    return res.json({
      success: true,
      data: {
        exportId,
        groundTruthS3Path,
        documentCount: byDocument.size,
        zoneCount: zones.length,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const evaluateBodySchema = z.object({
  trainingRunId: z.string().min(1),
});

// POST /api/v1/training/evaluate
router.post('/evaluate', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = evaluateBodySchema.safeParse(req.body);
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

    const result = await evaluateTrainingRun(parsed.data.trainingRunId);
    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message },
      });
    }
    if (message.includes('not COMPLETED')) {
      return res.status(422).json({
        success: false,
        error: { code: 'INVALID_STATE', message },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
});

// POST /api/v1/training/runs/:id/promote
router.post('/runs/:id/promote', authenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required to promote models' },
      });
    }

    const result = await promoteTrainingRun(
      req.params.id,
      String(authReq.user?.id ?? 'unknown'),
    );
    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('not found') || message.includes('no ONNX')) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
});

const rollbackBodySchema = z.object({
  confirm: z.literal('ROLLBACK'),
});

// POST /api/v1/training/runs/:id/rollback
router.post('/runs/:id/rollback', authenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required to rollback models' },
      });
    }

    const parsed = rollbackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Body must contain { confirm: "ROLLBACK" }',
        },
      });
    }

    const result = await rollbackTrainingRun(req.params.id);
    return res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('not found') || message.includes('no ONNX')) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message },
    });
  }
});

export default router;
