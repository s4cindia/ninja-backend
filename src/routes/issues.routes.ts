import { Router } from 'express';
import { issueDismissalController } from '../controllers/issue-dismissal.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

/**
 * Audit-issue dismissal routes.
 * Mounted under `/api/v1/jobs/:jobId/issues/...`.
 *
 * Each route authenticates the caller at the middleware level; the
 * controller then verifies the caller's tenant owns THIS job.
 */

/**
 * POST /api/v1/jobs/:jobId/issues/dismissals
 * Body: { code, location, message, reason? }
 * Dismisses one issue instance. Idempotent on { code, location, message }.
 */
router.post(
  '/:jobId/issues/dismissals',
  authenticate,
  issueDismissalController.createDismissal.bind(issueDismissalController),
);

/**
 * DELETE /api/v1/jobs/:jobId/issues/dismissals/:dismissalId
 * Removes a dismissal. 404 when the dismissal belongs to a different job.
 */
router.delete(
  '/:jobId/issues/dismissals/:dismissalId',
  authenticate,
  issueDismissalController.deleteDismissal.bind(issueDismissalController),
);

/**
 * GET /api/v1/jobs/:jobId/issues/dismissals?code=:code
 * Lists dismissals for the job; the `code` filter is optional.
 */
router.get(
  '/:jobId/issues/dismissals',
  authenticate,
  issueDismissalController.listDismissals.bind(issueDismissalController),
);

export default router;
