/**
 * Acrobat Report Routes
 *
 * Upload / read / remove the Acrobat Pro accessibility report for a PDF
 * job -- evidence for the EPUB-from-certified-PDF certification gate.
 * Mirrors the job PAC report's external-upload routes (pac-report.routes.ts):
 * writes allow the owner, an ADMIN or the owner's Team Leader
 * (authorizeJobForTeamLeaderAction -- the Team Leader who certifies must be
 * able to upload the evidence); the read also allows team reviewers
 * (authorizeJobForReview).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJobForReview, authorizeJobForTeamLeaderAction } from '../middleware/authorize-job.middleware';
import { rateLimiters } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { jobAcrobatReportUploadUrlSchema, jobAcrobatReportConfirmSchema } from '../schemas/job-acrobat-report.schemas';
import { acrobatReportController } from '../controllers/acrobat-report.controller';

const router = Router();

/** POST /api/v1/pdf/:jobId/acrobat-report/upload-url -- step 1 of 2: presigned PUT (text/html). */
router.post(
  '/:jobId/acrobat-report/upload-url',
  authenticate,
  authorizeJobForTeamLeaderAction,
  rateLimiters.styleGuideUpload,
  validate(jobAcrobatReportUploadUrlSchema),
  (req, res) => acrobatReportController.getUploadUrl(req, res),
);

/** POST /api/v1/pdf/:jobId/acrobat-report/confirm -- step 2 of 2: verify, parse, persist. */
router.post(
  '/:jobId/acrobat-report/confirm',
  authenticate,
  authorizeJobForTeamLeaderAction,
  validate(jobAcrobatReportConfirmSchema),
  (req, res) => acrobatReportController.confirmUpload(req, res),
);

/** GET /api/v1/pdf/:jobId/acrobat-report */
router.get(
  '/:jobId/acrobat-report',
  authenticate,
  authorizeJobForReview,
  (req, res) => acrobatReportController.getReport(req, res),
);

/** DELETE /api/v1/pdf/:jobId/acrobat-report */
router.delete(
  '/:jobId/acrobat-report',
  authenticate,
  authorizeJobForTeamLeaderAction,
  (req, res) => acrobatReportController.deleteReport(req, res),
);

export default router;
