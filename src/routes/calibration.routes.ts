import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { getCalibrationQueue } from '../queues';
import prisma from '../lib/prisma';
import { getCorpusStats } from '../services/calibration/corpus-stats.service';
import { runAiAnnotation, getAiAnnotationReport } from '../services/calibration/ai-annotation.service';
import { PROMPT_VERSION } from '../services/ai/prompts/zone-classification.prompts';
import { runAnnotationComparison, getComparisonReport } from '../services/calibration/annotation-comparison.service';
import { generateAnnotationGuide } from '../services/calibration/annotation-guide.service';
import { getAnnotationFeedback, getAggregateFeedback } from '../services/calibration/annotation-feedback.service';
import { getTrainingExportData } from '../services/calibration/training-export.service';
import { runBulkAiAnnotation } from '../services/calibration/bulk-ai-annotation.service';
import { getAggregateComparison } from '../services/calibration/aggregate-comparison.service';
import { logger } from '../lib/logger';

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
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 50,
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

    return res.json({ success: true, data: { runs } });
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
  limit: z.coerce.number().default(2000),
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
      orderBy: [{ pageNumber: 'asc' }, { id: 'asc' }],
    });

    let nextCursor: string | undefined;
    if (zones.length > limit) {
      const extra = zones.pop()!;
      nextCursor = extra.id;
    }

    return res.json({ success: true, data: { zones, nextCursor } });
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
        calibrationRuns: {
          orderBy: { runDate: 'desc' },
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

const batchBodySchema = z.object({
  documents: z.array(z.object({
    filename:      z.string().min(1),
    s3Path:        z.string().min(1),
    publisher:     z.string().optional(),
    contentType:   z.string().optional(),
    pageCount:     z.coerce.number().optional(),
    language:      z.string().default('en'),
    trainingSplit: z.enum(['train', 'val', 'test']).optional(),
  })).min(1).max(500),
});

// POST /api/v1/calibration/corpus-docs/batch
router.post('/corpus-docs/batch', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = batchBodySchema.safeParse(req.body);
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

    const { documents } = parsed.data;
    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const CHUNK = 50;

    // Deduplicate within the request payload
    const seenInRequest = new Set<string>();
    const dedupedDocuments: typeof documents = [];
    for (const doc of documents) {
      if (seenInRequest.has(doc.s3Path)) {
        results.skipped++;
        continue;
      }
      seenInRequest.add(doc.s3Path);
      dedupedDocuments.push(doc);
    }

    for (let i = 0; i < dedupedDocuments.length; i += CHUNK) {
      const chunk = dedupedDocuments.slice(i, i + CHUNK);

      try {
        const existing = await prisma.corpusDocument.findMany({
          where: { s3Path: { in: chunk.map(d => d.s3Path) } },
          select: { s3Path: true },
        });
        const existingPaths = new Set(existing.map(e => e.s3Path));

        const toCreate = [];
        for (const doc of chunk) {
          if (existingPaths.has(doc.s3Path)) {
            results.skipped++;
          } else {
            toCreate.push(doc);
          }
        }

        if (toCreate.length > 0) {
          const created = await prisma.corpusDocument.createMany({
            data: toCreate,
          });
          results.created += created.count;
        }
      } catch (err) {
        results.errors.push(`Chunk ${i}-${i + CHUNK}: ${(err as Error).message}`);
      }
    }

    return res.json({ success: true, data: results });
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

// --- AI Annotation Endpoints ---

const aiAnnotateBodySchema = z.object({
  confidenceThreshold: z.number().min(0).max(1).optional(),
  model: z.string().optional(),
  dryRun: z.boolean().optional(),
});

// POST /api/v1/calibration/runs/:runId/ai-annotate
// Returns 202 immediately; annotation runs in background.
// Poll GET /runs/:runId/ai-annotation-status for progress.
router.post('/runs/:runId/ai-annotate', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    const parsed = aiAnnotateBodySchema.safeParse(req.body);
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

    // Check for an already-running annotation on this run
    const existing = await prisma.aiAnnotationRun.findFirst({
      where: { calibrationRunId: runId, status: 'RUNNING' },
    });
    if (existing) {
      return res.status(202).json({
        success: true,
        data: { status: 'ALREADY_RUNNING', aiRunId: existing.id },
      });
    }

    // Create the record now so the poller can find it immediately
    const aiRun = await prisma.aiAnnotationRun.create({
      data: {
        calibrationRunId: runId,
        model: parsed.data.model ?? 'gemini-2.0-flash',
        promptVersion: PROMPT_VERSION,
        confidenceThreshold: parsed.data.confidenceThreshold ?? 0.95,
        dryRun: parsed.data.dryRun ?? false,
        status: 'RUNNING',
      },
    });

    logger.info(
      `[calibration] AI annotation triggered for run ${runId} (aiRun ${aiRun.id}) by user ${req.user!.id}`,
    );

    // Fire-and-forget: run annotation in background, passing pre-created aiRunId
    runAiAnnotation(runId, { ...parsed.data, aiRunId: aiRun.id }).catch((err) => {
      logger.error(`[calibration] AI annotation failed for run ${runId}: ${(err as Error).message}`);
    });

    return res.status(202).json({
      success: true,
      data: { status: 'STARTED', aiRunId: aiRun.id },
    });
  } catch (err) {
    logger.error(`[calibration] AI annotation failed for run ${req.params.runId}: ${(err as Error).message}`);
    return res.status(500).json({
      success: false,
      error: { code: 'AI_ANNOTATION_FAILED', message: (err as Error).message },
    });
  }
});

// GET /api/v1/calibration/runs/:runId/ai-annotation-status?aiRunId=xxx
// Polls a specific AI annotation run, or the latest if no aiRunId given.
router.get('/runs/:runId/ai-annotation-status', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const { aiRunId } = req.query;

    let run;
    if (aiRunId && typeof aiRunId === 'string') {
      run = await prisma.aiAnnotationRun.findUnique({
        where: { id: aiRunId },
      });
    } else {
      run = await prisma.aiAnnotationRun.findFirst({
        where: { calibrationRunId: runId },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!run) {
      return res.json({
        success: true,
        data: { status: 'NONE', message: 'No AI annotation runs found' },
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

// GET /api/v1/calibration/runs/:runId/ai-annotation-report
router.get('/runs/:runId/ai-annotation-report', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    const report = await getAiAnnotationReport(runId);
    return res.json({ success: true, data: report });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// --- Annotation Comparison Endpoints ---

// POST /api/v1/calibration/runs/:runId/compare
router.post('/runs/:runId/compare', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    const result = await runAnnotationComparison(runId);

    logger.info(
      `[calibration] Annotation comparison triggered for run ${runId} by user ${req.user!.id}`,
    );

    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[calibration] Annotation comparison failed for run ${req.params.runId}: ${(err as Error).message}`);
    return res.status(500).json({
      success: false,
      error: { code: 'COMPARISON_FAILED', message: (err as Error).message },
    });
  }
});

// GET /api/v1/calibration/runs/:runId/comparison-report
router.get('/runs/:runId/comparison-report', authenticate, async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    const report = await getComparisonReport(runId);
    return res.json({ success: true, data: report });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// --- Annotation Guide Endpoint ---

// GET /api/v1/calibration/runs/:runId/annotation-guide
router.get('/runs/:runId/annotation-guide', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;

    const run = await prisma.calibrationRun.findUnique({ where: { id: runId } });
    if (!run) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `CalibrationRun ${runId} not found` },
      });
    }

    const guide = await generateAnnotationGuide(runId);
    return res.json({ success: true, data: guide });
  } catch (err) {
    logger.error(`[calibration] Annotation guide failed for run ${req.params.runId}: ${(err as Error).message}`);
    return res.status(500).json({
      success: false,
      error: { code: 'GUIDE_GENERATION_FAILED', message: (err as Error).message },
    });
  }
});

// --- Annotation Feedback Endpoints ---

// GET /api/v1/calibration/runs/:runId/feedback
router.get('/runs/:runId/feedback', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const feedback = await getAnnotationFeedback(runId);
    return res.json({ success: true, data: feedback });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/calibration/feedback/aggregate
router.post('/feedback/aggregate', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      calibrationRunIds: z.array(z.string()).min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.issues },
      });
    }
    const result = await getAggregateFeedback(parsed.data.calibrationRunIds);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// --- Training Export Endpoint ---

// POST /api/v1/calibration/export-training
router.post('/export-training', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      documentIds: z.array(z.string()).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      includeAiOnly: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.issues },
      });
    }
    const result = await getTrainingExportData(parsed.data);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[calibration] Training export failed: ${(err as Error).message}`);
    return res.status(500).json({
      success: false,
      error: { code: 'EXPORT_FAILED', message: (err as Error).message },
    });
  }
});

// --- Bulk AI Annotation Endpoint ---

const bulkAiAnnotateSchema = z.object({
  documentIds: z.array(z.string()).optional(),
  runIds: z.array(z.string()).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  model: z.string().optional(),
  dryRun: z.boolean().optional(),
}).refine((d) => d.documentIds?.length || d.runIds?.length, {
  message: 'Either documentIds or runIds must be provided',
});

// POST /api/v1/calibration/ai-annotate-batch
router.post('/ai-annotate-batch', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const parsed = bulkAiAnnotateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.issues },
      });
    }

    logger.info(`[calibration] Bulk AI annotation triggered by user ${req.user!.id}`);
    const result = await runBulkAiAnnotation(parsed.data);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[calibration] Bulk AI annotation failed: ${(err as Error).message}`);
    return res.status(500).json({
      success: false,
      error: { code: 'BULK_ANNOTATION_FAILED', message: (err as Error).message },
    });
  }
});

// --- Aggregate Comparison Endpoint ---

// POST /api/v1/calibration/comparison/aggregate
router.post('/comparison/aggregate', authenticate, authorize('ADMIN', 'USER'), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      documentIds: z.array(z.string()).optional(),
      fromDate: z.string().datetime().optional(),
      toDate: z.string().datetime().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.issues },
      });
    }

    const result = await getAggregateComparison({
      documentIds: parsed.data.documentIds,
      fromDate: parsed.data.fromDate ? new Date(parsed.data.fromDate) : undefined,
      toDate: parsed.data.toDate ? new Date(parsed.data.toDate) : undefined,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
