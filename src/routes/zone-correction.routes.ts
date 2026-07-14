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

// POST /api/v1/calibration/zones/bulk-reject
// Reject many zones in one call — either an explicit list (multi-select in the
// editor) or a filter (e.g. "reject all remaining formula boxes on this page").
// Unblocks cleaning up dense pages that carry hundreds of per-cell boxes.
const bulkRejectSchema = z.object({
  zoneIds: z.array(z.string().min(1)).max(5000).optional(),
  filter: z.object({
    calibrationRunId: z.string().min(1),
    pageNumber: z.number().int().optional(),
    operatorLabel: z.string().min(1).optional(),
  }).optional(),
  correctionReason: z.string().optional(),
}).refine((d) => (d.zoneIds && d.zoneIds.length > 0) || d.filter, {
  message: 'Provide a non-empty zoneIds array or a filter',
});

router.post('/zones/bulk-reject', authenticate, async (req: Request, res: Response) => {
  try {
    const operatorId = req.user!.id;
    const tenantId = req.user!.tenantId;
    const parsed = bulkRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }
    const { zoneIds, filter, correctionReason } = parsed.data;

    // Explicit ids win; otherwise reject all still-active zones matching the
    // filter. Always scope to the caller's tenant so one tenant can't reject
    // another tenant's zones by id.
    const where: Prisma.ZoneWhereInput = zoneIds && zoneIds.length > 0
      ? { tenantId, id: { in: zoneIds } }
      : {
          tenantId,
          calibrationRunId: filter!.calibrationRunId,
          ...(filter!.pageNumber != null ? { pageNumber: filter!.pageNumber } : {}),
          ...(filter!.operatorLabel
            ? { operatorLabel: { equals: filter!.operatorLabel, mode: 'insensitive' } }
            : {}),
          decision: { not: 'REJECTED' },
        };

    const result = await prisma.zone.updateMany({
      where,
      data: {
        isArtefact: true,
        decision: 'REJECTED',
        correctionReason: correctionReason ?? null,
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.json({ success: true, data: { rejectedCount: result.count } });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/calibration/runs/:runId/zones
// Create a new operator-drawn zone (e.g. a box around a whole matrix on a page
// where extraction only produced cell-level boxes). Writes `bounds` — the field
// the training export reads — so drawn boxes reach training (unlike Correct,
// which stores operatorBbox that the export ignores).
const createZoneSchema = z.object({
  pageNumber: z.number().int().positive(),
  operatorLabel: z.string().min(1),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  }),
  type: z.string().optional(),
});

router.post('/runs/:runId/zones', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const operatorId = req.user!.id;
    const tenantId = req.user!.tenantId;

    const parsed = createZoneSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }
    const { pageNumber, operatorLabel, bounds, type } = parsed.data;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId }, select: { id: true } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Calibration run not found' },
      });
    }

    const created = await prisma.zone.create({
      data: {
        tenantId,
        calibrationRunId: runId,
        pageNumber,
        type: type ?? operatorLabel,
        bounds,
        source: 'operator',
        reconciliationBucket: 'GREEN',
        operatorVerified: true,
        operatorLabel,
        decision: 'CORRECTED',
        verifiedAt: new Date(),
        verifiedBy: operatorId,
      },
    });

    return res.status(201).json({ success: true, data: created });
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
