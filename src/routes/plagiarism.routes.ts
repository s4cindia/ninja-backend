/**
 * Plagiarism Check Routes
 *
 * API routes for plagiarism detection:
 * - Start plagiarism check
 * - Get job status
 * - Get matches (filtered, paginated)
 * - Get summary
 * - Review match / bulk review
 */

import { Router } from 'express';
import { plagiarismController } from '../controllers/plagiarism/plagiarism.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  startPlagiarismCheckSchema,
  plagiarismJobIdParamSchema,
  getMatchesSchema,
  plagiarismDocumentIdParamSchema,
  reviewMatchSchema,
  bulkReviewSchema,
} from '../schemas/plagiarism.schemas';

const router = Router();

// All routes require authentication
router.use(authenticate);

// -- Check Management --

/**
 * Start a plagiarism check
 * POST /api/v1/plagiarism/check
 */
router.post(
  '/check',
  validate(startPlagiarismCheckSchema),
  (req, res, next) => plagiarismController.startCheck(req, res, next)
);

/**
 * Get job status
 * GET /api/v1/plagiarism/job/:jobId
 */
router.get(
  '/job/:jobId',
  validate(plagiarismJobIdParamSchema),
  (req, res, next) => plagiarismController.getJobStatus(req, res, next)
);

// -- Match Retrieval --

/**
 * Get matches for a document (filtered, paginated)
 * GET /api/v1/plagiarism/document/:documentId
 */
router.get(
  '/document/:documentId',
  validate(getMatchesSchema),
  (req, res, next) => plagiarismController.getMatches(req, res, next)
);

/**
 * Get summary grouped by type/classification/status
 * GET /api/v1/plagiarism/document/:documentId/summary
 */
router.get(
  '/document/:documentId/summary',
  validate(plagiarismDocumentIdParamSchema),
  (req, res, next) => plagiarismController.getSummary(req, res, next)
);

// -- Match Actions (static routes BEFORE parameterized) --

/**
 * Bulk review matches
 * POST /api/v1/plagiarism/matches/bulk
 */
router.post(
  '/matches/bulk',
  validate(bulkReviewSchema),
  (req, res, next) => plagiarismController.bulkReview(req, res, next)
);

/**
 * Review a single match
 * POST /api/v1/plagiarism/match/:matchId/review
 */
router.post(
  '/match/:matchId/review',
  validate(reviewMatchSchema),
  (req, res, next) => plagiarismController.reviewMatch(req, res, next)
);

export default router;
