/**
 * PAC Report Routes
 *
 * Matterhorn Protocol 1.1 compliance report endpoints.
 * Matterhorn Coverage Plan — Step 5
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { rateLimiters } from '../middleware/rate-limit.middleware';
import { pacReportController } from '../controllers/pac-report.controller';

const router = Router();

/**
 * GET /api/v1/pdf/:jobId/pac-report
 * Returns the full 137-condition Matterhorn compliance report as JSON.
 */
router.get(
  '/:jobId/pac-report',
  authenticate,
  authorizeJob,
  (req, res) => pacReportController.getReport(req, res),
);

/**
 * POST /api/v1/pdf/:jobId/pac-report/live
 * Runs the job's document through axes4's real, external PAC Cloud checker
 * -- separate from the free, instant, simulated report above. Costs real
 * money per page and can take minutes; never called automatically. See
 * PacReportController.getLiveReport's own doc comment.
 */
router.post(
  '/:jobId/pac-report/live',
  authenticate,
  authorizeJob,
  rateLimiters.axes4LiveCheck,
  (req, res) => pacReportController.getLiveReport(req, res),
);

export default router;
