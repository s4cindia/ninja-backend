/**
 * PAC Report Routes
 *
 * Matterhorn Protocol 1.1 compliance report endpoints.
 * Matterhorn Coverage Plan — Step 5
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
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

export default router;
