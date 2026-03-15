import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';

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

export default router;
