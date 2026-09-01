/**
 * Comparison Study Routes
 *
 * Standalone admin section for the pdfxt-vs-Ninja validation study —
 * same shape as admin/corpus.routes.ts (upload-url -> register -> list),
 * plus the pdfxt data-entry, validate, and report endpoints.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import { AppError } from '../../utils/app-error';
import {
  generateUploadUrl,
  registerTrial,
  listTrials,
  getTrial,
  deleteTrial,
  logPdfxtData,
  validateTrial,
  getTrialReport,
  getAggregateReport,
  updateAutoModeConfig,
} from '../../services/comparison-study/comparison-study.service';

const router = Router();

const isAdminOrOperator = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return ['admin', 'ADMIN', 'OPERATOR'].includes(role ?? '');
};

const forbidden = (res: Response) =>
  res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
  });

const internalError = (res: Response, err: unknown) =>
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
  });

const uploadUrlBodySchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/pdf'),
});

// POST /api/v1/admin/comparison-study/upload-url
router.post('/comparison-study/upload-url', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const parsed = uploadUrlBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const result = await generateUploadUrl(parsed.data.filename, parsed.data.contentType);
    return res.json({ success: true, data: result });
  } catch (err) {
    return internalError(res, err);
  }
});

const registerBodySchema = z.object({
  sourceFileName: z.string().min(1),
  sourceS3Key: z.string().min(1),
  contentType: z.enum(['text-dominant', 'table-heavy', 'figure-heavy', 'mixed']),
});

// POST /api/v1/admin/comparison-study/trials
router.post('/comparison-study/trials', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const user = (req as Request & { user?: { id: string; tenantId: string } }).user!;
    const trial = await registerTrial({
      ...parsed.data,
      operatorId: user.id,
      tenantId: user.tenantId,
      userId: user.id,
    });
    return res.status(201).json({ success: true, data: trial });
  } catch (err) {
    return internalError(res, err);
  }
});

const listQuerySchema = z.object({
  limit: z.coerce.number().default(20),
  cursor: z.string().optional(),
  status: z.string().optional(),
  contentType: z.string().optional(),
});

// GET /api/v1/admin/comparison-study/trials
router.get('/comparison-study/trials', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const result = await listTrials(parsed.data);
    return res.json({ success: true, data: result });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/admin/comparison-study/trials/:id
router.get('/comparison-study/trials/:id', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const trial = await getTrial(req.params.id);
    if (!trial) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Trial not found' } });
    }
    return res.json({ success: true, data: trial });
  } catch (err) {
    return internalError(res, err);
  }
});

// DELETE /api/v1/admin/comparison-study/trials/:id
router.delete('/comparison-study/trials/:id', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const deleted = await deleteTrial(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Trial not found' } });
    }
    return res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    return internalError(res, err);
  }
});

const pdfxtBodySchema = z.object({
  pdfxtS3Key: z.string().optional(),
  pdfxtTimeMs: z.number().int().positive().optional(),
  pdfxtPageCount: z.number().int().positive().optional(),
  pdfxtCostUsd: z.number().nonnegative().optional(),
});

// PATCH /api/v1/admin/comparison-study/trials/:id/pdfxt
router.patch('/comparison-study/trials/:id/pdfxt', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const parsed = pdfxtBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const trial = await logPdfxtData(req.params.id, parsed.data);
    return res.json({ success: true, data: trial });
  } catch (err) {
    return internalError(res, err);
  }
});

const autoModeConfigBodySchema = z.object({
  mode: z.enum(['manual', 'auto']).optional(),
  autoMaxRounds: z.number().int().positive().max(100).optional(),
  autoCostLimitUsd: z.number().positive().max(1000).optional(),
  autoColorContrastMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).nullable().optional(),
});

// PATCH /api/v1/admin/comparison-study/trials/:id/auto-mode
router.patch('/comparison-study/trials/:id/auto-mode', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const parsed = autoModeConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const trial = await updateAutoModeConfig(req.params.id, parsed.data);
    return res.json({ success: true, data: trial });
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    }
    return internalError(res, err);
  }
});

// POST /api/v1/admin/comparison-study/trials/:id/validate
router.post('/comparison-study/trials/:id/validate', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const trial = await validateTrial(req.params.id);
    return res.json({ success: true, data: trial });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/admin/comparison-study/trials/:id/report
router.get('/comparison-study/trials/:id/report', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const report = await getTrialReport(req.params.id);
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/admin/comparison-study/aggregate-report
router.get('/comparison-study/aggregate-report', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const report = await getAggregateReport();
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, err);
  }
});

export default router;
