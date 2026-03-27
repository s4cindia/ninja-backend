import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import prisma, { Prisma } from '../lib/prisma';
import { runAutoAnnotation } from '../services/calibration/auto-annotation.service';

const router = Router();

// POST /api/v1/calibration/zones/:zoneId/confirm
router.post('/zones/:zoneId/confirm', authenticate, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const operatorId = req.user!.id;

    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Zone not found' },
      });
    }

    const updated = await prisma.zone.update({
      where: { id: zoneId },
      data: {
        operatorVerified: true,
        operatorLabel: zone.operatorLabel ?? zone.type,
        isArtefact: false,
        decision: 'CONFIRMED',
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const correctBodySchema = z.object({
  newLabel: z.string().min(1),
  correctionReason: z.string().optional(),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).optional(),
});

// POST /api/v1/calibration/zones/:zoneId/correct
router.post('/zones/:zoneId/correct', authenticate, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const operatorId = req.user!.id;

    const parsed = correctBodySchema.safeParse(req.body);
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

    const { newLabel, correctionReason, bbox } = parsed.data;

    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Zone not found' },
      });
    }

    const updated = await prisma.zone.update({
      where: { id: zoneId },
      data: {
        operatorVerified: true,
        operatorLabel: newLabel,
        operatorBbox: bbox ?? Prisma.DbNull,
        isArtefact: false,
        decision: 'CORRECTED',
        correctionReason: correctionReason ?? null,
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/calibration/zones/:zoneId/reject
const rejectBodySchema = z.object({
  correctionReason: z.string().optional(),
}).optional();

router.post('/zones/:zoneId/reject', authenticate, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.params;
    const operatorId = req.user!.id;
    const parsed = rejectBodySchema.safeParse(req.body);
    const correctionReason = parsed.success ? parsed.data?.correctionReason : undefined;

    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Zone not found' },
      });
    }

    const updated = await prisma.zone.update({
      where: { id: zoneId },
      data: {
        isArtefact: true,
        decision: 'REJECTED',
        correctionReason: correctionReason ?? null,
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/calibration/runs/:runId/confirm-all-green
// Approach: updateMany for boolean/datetime fields.
// operatorLabel is not set per-zone — at display time the frontend
// falls back to zone.type when operatorLabel is null.
router.post('/runs/:runId/confirm-all-green', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const operatorId = req.user!.id;

    const result = await prisma.zone.updateMany({
      where: {
        calibrationRunId: runId,
        reconciliationBucket: 'GREEN',
        operatorVerified: false,
      },
      data: {
        operatorVerified: true,
        isArtefact: false,
        decision: 'CONFIRMED',
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.json({ success: true, data: { confirmedCount: result.count } });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/calibration/runs/:runId/auto-annotate
// Apply rule-based auto-annotation patterns to unreviewed zones.
// Optional body: { patterns: ["ghost-zone-rejection", "toci-bulk-confirm", ...] }
// If patterns is omitted or empty, all patterns are applied.
const autoAnnotateBodySchema = z.object({
  patterns: z.array(z.string()).optional(),
}).optional();

router.post('/runs/:runId/auto-annotate', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    // Verify run exists
    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Calibration run not found' },
      });
    }

    const parsed = autoAnnotateBodySchema.safeParse(req.body);
    const patterns = parsed.success ? parsed.data?.patterns : undefined;

    const result = await runAutoAnnotation(runId, patterns);

    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
