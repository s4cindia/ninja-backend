/**
 * PDF Auto-Remediation-Mode Routes
 *
 * Start/status/stop endpoints for the auto-remediation loop. Works for a
 * ComparisonTrial-linked job (original, research-tooling path) or any other
 * job the caller owns (production path, added so Auto Mode isn't
 * trial-exclusive -- see pdf-auto-mode.controller.ts). All routes require
 * authentication + job ownership authorization; no trial-awareness at the
 * middleware level, same as pdf-remediation.routes.ts.
 * Base path (registered in index.ts): /pdf
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { validate } from '../middleware/validate.middleware';
import { startAutoModeSchema } from '../schemas/pdf-auto-mode.schemas';
import { pdfAutoModeController } from '../controllers/pdf-auto-mode.controller';

const router = Router();

/**
 * POST /pdf/:jobId/auto-mode/start
 * Start the auto-remediation loop for this job (async, returns 202). Works
 * for a trial-linked job (existing behavior, request body ignored) or any
 * other job the caller owns (new -- see the controller's own doc comment).
 * The optional body only applies on the latter path.
 */
router.post(
  '/:jobId/auto-mode/start',
  authenticate,
  authorizeJob,
  validate(startAutoModeSchema),
  pdfAutoModeController.start.bind(pdfAutoModeController)
);

/**
 * GET /pdf/:jobId/auto-mode/status
 */
router.get(
  '/:jobId/auto-mode/status',
  authenticate,
  authorizeJob,
  pdfAutoModeController.getStatus.bind(pdfAutoModeController)
);

/**
 * POST /pdf/:jobId/auto-mode/stop
 */
router.post(
  '/:jobId/auto-mode/stop',
  authenticate,
  authorizeJob,
  pdfAutoModeController.stop.bind(pdfAutoModeController)
);

export default router;
