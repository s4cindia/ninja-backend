/**
 * PDF Auto-Remediation-Mode Routes
 *
 * Start/status/stop endpoints for a ComparisonTrial's auto-remediation loop.
 * All routes require authentication + job ownership authorization.
 * Base path (registered in index.ts): /pdf
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { pdfAutoModeController } from '../controllers/pdf-auto-mode.controller';

const router = Router();

/**
 * POST /pdf/:jobId/auto-mode/start
 * Start the auto-remediation loop for this job's trial (async, returns 202).
 */
router.post(
  '/:jobId/auto-mode/start',
  authenticate,
  authorizeJob,
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
