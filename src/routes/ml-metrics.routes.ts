import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';
import { calculateMAP } from '../services/metrics/map.service';
import {
  saveMapSnapshot,
  getMapSnapshot,
  getMapHistory,
} from '../services/metrics/map-persistence';
import type { AnnotatedZone, PredictedZone } from '../services/metrics/ml-metrics.types';
import type { BBox } from '../services/calibration/iou';
import type { CanonicalZoneType } from '../services/zone-extractor/types';

const router = Router();

router.use(authenticate);

const runMapSchema = z.object({
  runId: z.string().min(1),
});

// POST /api/v1/ml-metrics/map
router.post('/map', async (req: Request, res: Response) => {
  try {
    const parsed = runMapSchema.safeParse(req.body);
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

    const { runId } = parsed.data;

    // Verify run exists
    const run = await prisma.calibrationRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    // Fetch operator-verified zones as ground truth
    const gtZones = await prisma.zone.findMany({
      where: {
        calibrationRunId: runId,
        operatorVerified: true,
        isArtefact: false,
      },
    });

    const groundTruth: AnnotatedZone[] = gtZones.map((z) => ({
      pageNumber: z.pageNumber,
      bbox: z.bounds as unknown as BBox,
      zoneType: (z.operatorLabel ?? z.type) as CanonicalZoneType,
    }));

    // Fetch docling predictions
    const predZones = await prisma.zone.findMany({
      where: {
        calibrationRunId: runId,
        source: 'docling',
      },
    });

    const predictions: PredictedZone[] = predZones.map((z) => ({
      pageNumber: z.pageNumber,
      bbox: z.bounds as unknown as BBox,
      zoneType: z.type as CanonicalZoneType,
      confidence: z.doclingConfidence ?? 0.5,
    }));

    const result = calculateMAP(groundTruth, predictions);
    await saveMapSnapshot(runId, result);

    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/ml-metrics/map/:runId
router.get('/map/:runId', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const result = await getMapSnapshot(runId);

    if (!result) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `mAP snapshot for run ${runId} not found` },
      });
    }

    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/ml-metrics/map/history
// NOTE: must be before /map/:runId but Express will match 'history' as :runId
// So we register this route specifically
router.get('/map-history', async (req: Request, res: Response) => {
  try {
    const { fromDate, toDate } = req.query;
    const from = fromDate && typeof fromDate === 'string' ? new Date(fromDate) : undefined;
    const to = toDate && typeof toDate === 'string' ? new Date(toDate) : undefined;

    const snapshots = await getMapHistory(from, to);
    return res.json({ success: true, data: snapshots });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/ml-metrics/phase-gate
router.get('/phase-gate', async (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      criteria: [
        {
          id: 'C1',
          label: 'Overall mAP ≥75%',
          status: 'AMBER',
          currentValue: 'pending',
          threshold: '75%',
          tooltip: 'Run POST /ml-metrics/map to compute',
        },
        {
          id: 'C2',
          label: 'All 8 zone types ≥30 instances',
          status: 'AMBER',
          currentValue: 'pending',
          threshold: '30 per type',
          tooltip: 'Requires 300+ annotated pages',
        },
        {
          id: 'C3',
          label: 'Publisher diversity ≥3',
          status: 'AMBER',
          currentValue: 'pending',
          threshold: '3 publishers',
          tooltip: 'Pending corpus',
        },
        {
          id: 'C4',
          label: 'Content type diversity ≥3',
          status: 'AMBER',
          currentValue: 'pending',
          threshold: '3 content types',
          tooltip: 'Pending corpus',
        },
        {
          id: 'C5',
          label: 'Write quality pass rate ≥95%',
          status: 'AMBER',
          currentValue: 'pending',
          threshold: '95% PAC 2024',
          tooltip: 'Pending pikepdf spike (ML-3.8)',
        },
      ],
      overallStatus: 'AMBER',
      readyForPhase2: false,
    },
  });
});

export default router;
