import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import {
  pageNumberParamSchema,
  upsertEmptyPageReviewSchema,
} from '../schemas/empty-page-review.schema';
import {
  calibrationRunExists,
  deleteReview,
  getReview,
  listReviews,
  upsertReview,
} from '../services/empty-page-review.service';

const ROLE_VALUES = ['admin', 'ADMIN', 'OPERATOR'];

function isAdminOrOperator(req: Request): boolean {
  const role = req.user?.role;
  return role !== undefined && ROLE_VALUES.includes(role);
}

function forbidden(res: Response) {
  return res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
  });
}

function notFound(res: Response, message: string, code = 'NOT_FOUND') {
  return res.status(404).json({
    success: false,
    error: { code, message },
  });
}

function validationError(res: Response, message: string, details: unknown) {
  return res.status(422).json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message, details },
  });
}

function internalError(res: Response, err: unknown) {
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
  });
}

function parsePageNumber(raw: string) {
  return pageNumberParamSchema.safeParse(raw);
}

export async function listEmptyPageReviews(req: Request, res: Response) {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const { runId } = req.params;
    if (!(await calibrationRunExists(runId))) {
      return notFound(res, 'Calibration run not found', 'RUN_NOT_FOUND');
    }

    const reviews = await listReviews(runId);
    return res.json({ success: true, data: { reviews } });
  } catch (err) {
    logger.error(`[empty-page-review] list failed: ${(err as Error).message}`);
    return internalError(res, err);
  }
}

export async function getEmptyPageReview(req: Request, res: Response) {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const { runId } = req.params;
    const pageParse = parsePageNumber(req.params.pageNumber);
    if (!pageParse.success) {
      return validationError(res, 'pageNumber must be a positive integer', pageParse.error.issues);
    }

    if (!(await calibrationRunExists(runId))) {
      return notFound(res, 'Calibration run not found', 'RUN_NOT_FOUND');
    }

    const review = await getReview(runId, pageParse.data);
    if (!review) {
      return notFound(res, 'No review exists for this page', 'REVIEW_NOT_FOUND');
    }

    return res.json({ success: true, data: review });
  } catch (err) {
    logger.error(`[empty-page-review] get failed: ${(err as Error).message}`);
    return internalError(res, err);
  }
}

export async function upsertEmptyPageReview(req: Request, res: Response) {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const { runId } = req.params;
    const pageParse = parsePageNumber(req.params.pageNumber);
    if (!pageParse.success) {
      return validationError(res, 'pageNumber must be a positive integer', pageParse.error.issues);
    }

    const bodyParse = upsertEmptyPageReviewSchema.safeParse(req.body);
    if (!bodyParse.success) {
      return validationError(res, 'Request validation failed', bodyParse.error.issues);
    }

    if (!(await calibrationRunExists(runId))) {
      return notFound(res, 'Calibration run not found', 'RUN_NOT_FOUND');
    }

    const annotatorId = req.user?.id;
    if (!annotatorId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'No authenticated user on request' },
      });
    }

    const review = await upsertReview(runId, pageParse.data, annotatorId, bodyParse.data);
    return res.json({ success: true, data: review });
  } catch (err) {
    logger.error(`[empty-page-review] upsert failed: ${(err as Error).message}`);
    return internalError(res, err);
  }
}

export async function deleteEmptyPageReview(req: Request, res: Response) {
  try {
    if (!isAdminOrOperator(req)) return forbidden(res);

    const { runId } = req.params;
    const pageParse = parsePageNumber(req.params.pageNumber);
    if (!pageParse.success) {
      return validationError(res, 'pageNumber must be a positive integer', pageParse.error.issues);
    }

    if (!(await calibrationRunExists(runId))) {
      return notFound(res, 'Calibration run not found', 'RUN_NOT_FOUND');
    }

    const deleted = await deleteReview(runId, pageParse.data);
    if (!deleted) {
      return notFound(res, 'No review exists for this page', 'REVIEW_NOT_FOUND');
    }

    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    logger.error(`[empty-page-review] delete failed: ${(err as Error).message}`);
    return internalError(res, err);
  }
}
