/**
 * PAC Report Routes
 *
 * Matterhorn Protocol 1.1 compliance report endpoints.
 * Matterhorn Coverage Plan — Step 5
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob, authorizeJobForReview } from '../middleware/authorize-job.middleware';
import { rateLimiters } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { jobPacReportUploadUrlSchema, jobPacReportConfirmSchema } from '../schemas/job-pac-report.schemas';
import { pacReportController } from '../controllers/pac-report.controller';

const router = Router();

/**
 * GET /api/v1/pdf/axes4/quota
 * Returns the current axes4 PAC Cloud page-quota status. Static route,
 * registered before the parameterized `/:jobId/...` routes below per this
 * repo's own convention (static routes before parameterized routes).
 */
router.get(
  '/axes4/quota',
  authenticate,
  (req, res) => pacReportController.getQuotaStatus(req, res),
);

/**
 * GET /api/v1/pdf/:jobId/pac-report
 * Returns the full 137-condition Matterhorn compliance report as JSON.
 */
router.get(
  '/:jobId/pac-report',
  authenticate,
  authorizeJobForReview,
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

/**
 * POST /api/v1/pdf/:jobId/pac-report/external/upload-url
 * Job-native counterpart to the Comparison Study admin upload flow --
 * presigned PUT URL for an operator to upload a real, external PAC-tool
 * report against this job. Step 1 of 2; see /confirm below.
 */
router.post(
  '/:jobId/pac-report/external/upload-url',
  authenticate,
  authorizeJob,
  rateLimiters.styleGuideUpload,
  validate(jobPacReportUploadUrlSchema),
  (req, res) => pacReportController.getExternalUploadUrl(req, res),
);

/**
 * POST /api/v1/pdf/:jobId/pac-report/external/confirm
 * Step 2 of 2: regenerates the deterministic S3 key, verifies the object
 * actually landed, and persists the report record + summary counts.
 */
router.post(
  '/:jobId/pac-report/external/confirm',
  authenticate,
  authorizeJob,
  validate(jobPacReportConfirmSchema),
  (req, res) => pacReportController.confirmExternalUpload(req, res),
);

/**
 * GET /api/v1/pdf/:jobId/pac-report/external
 * Returns the job's uploaded external PAC report (plus a fresh presigned
 * download URL), or null if none has been uploaded yet. Read-only, so
 * team reviewers can view it too.
 */
router.get(
  '/:jobId/pac-report/external',
  authenticate,
  authorizeJobForReview,
  (req, res) => pacReportController.getExternalReport(req, res),
);

/**
 * DELETE /api/v1/pdf/:jobId/pac-report/external
 */
router.delete(
  '/:jobId/pac-report/external',
  authenticate,
  authorizeJob,
  (req, res) => pacReportController.deleteExternalReport(req, res),
);

export default router;
