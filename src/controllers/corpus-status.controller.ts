import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import {
  listCorpusStatus,
  updateDocumentStatus,
} from '../services/calibration/corpus-status.service';
import {
  documentIdParamSchema,
  updateCorpusStatusSchema,
} from '../schemas/corpus-status.schema';

const ADMIN_OR_OPERATOR = new Set(['admin', 'ADMIN', 'OPERATOR']);

function hasAdminOrOperatorRole(req: Request): boolean {
  return ADMIN_OR_OPERATOR.has(req.user?.role ?? '');
}

// GET /api/v1/calibration/corpus-status
export async function getCorpusStatus(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }
    if (!hasAdminOrOperatorRole(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
      });
    }

    const data = await listCorpusStatus();
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('GET /calibration/corpus-status error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
}

// PUT /api/v1/admin/corpus/documents/:documentId/status
export async function putCorpusDocumentStatus(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }
    if (!hasAdminOrOperatorRole(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
      });
    }

    const idParse = documentIdParamSchema.safeParse(req.params.documentId);
    if (!idParse.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid documentId',
          details: idParse.error.issues,
        },
      });
    }

    const bodyParse = updateCorpusStatusSchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: bodyParse.error.issues,
        },
      });
    }

    const updated = await updateDocumentStatus(
      idParse.data,
      bodyParse.data,
      req.user.id,
    );
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    logger.error('PUT /admin/corpus/documents/:documentId/status error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
}
