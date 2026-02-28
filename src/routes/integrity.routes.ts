/**
 * Integrity Check Routes
 *
 * API routes for document integrity checking:
 * - Start checks (figure refs, citation refs, numbering, units, etc.)
 * - Get job status
 * - Get issues (filtered, paginated)
 * - Get summary
 * - Apply fix / ignore / bulk actions
 */

import { Router } from 'express';
import { integrityController } from '../controllers/integrity/integrity.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  startCheckSchema,
  jobIdParamSchema,
  getIssuesSchema,
  documentIdParamSchema,
  applyFixSchema,
  ignoreIssueSchema,
  bulkActionSchema,
} from '../schemas/integrity.schemas';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ── Check Management ─────────────────────────────────────────────

/**
 * Start an integrity check
 * POST /api/v1/integrity/check
 */
router.post(
  '/check',
  validate(startCheckSchema),
  (req, res, next) => integrityController.startCheck(req, res, next)
);

/**
 * Get job status
 * GET /api/v1/integrity/job/:jobId
 */
router.get(
  '/job/:jobId',
  validate(jobIdParamSchema),
  (req, res, next) => integrityController.getJobStatus(req, res, next)
);

// ── Issue Retrieval ──────────────────────────────────────────────

/**
 * Get issues for a document (filtered, paginated)
 * GET /api/v1/integrity/document/:documentId
 */
router.get(
  '/document/:documentId',
  validate(getIssuesSchema),
  (req, res, next) => integrityController.getIssues(req, res, next)
);

/**
 * Get summary grouped by check type
 * GET /api/v1/integrity/document/:documentId/summary
 */
router.get(
  '/document/:documentId/summary',
  validate(documentIdParamSchema),
  (req, res, next) => integrityController.getSummary(req, res, next)
);

// ── Issue Actions (static routes BEFORE parameterized) ───────────

/**
 * Bulk fix/ignore issues
 * POST /api/v1/integrity/issues/bulk
 */
router.post(
  '/issues/bulk',
  validate(bulkActionSchema),
  (req, res, next) => integrityController.bulkAction(req, res, next)
);

/**
 * Apply fix to an issue
 * POST /api/v1/integrity/issue/:issueId/fix
 */
router.post(
  '/issue/:issueId/fix',
  validate(applyFixSchema),
  (req, res, next) => integrityController.applyFix(req, res, next)
);

/**
 * Ignore an issue
 * POST /api/v1/integrity/issue/:issueId/ignore
 */
router.post(
  '/issue/:issueId/ignore',
  validate(ignoreIssueSchema),
  (req, res, next) => integrityController.ignoreIssue(req, res, next)
);

export default router;
