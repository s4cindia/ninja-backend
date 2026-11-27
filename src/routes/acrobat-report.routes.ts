/**
 * Acrobat Report Routes
 *
 * Upload / read / remove the Acrobat Pro accessibility report for a PDF
 * job -- evidence for the EPUB-from-certified-PDF certification gate.
 * Mirrors the job PAC report's external-upload routes (pac-report.routes.ts):
 * writes are owner/ADMIN only (authorizeJob), the read also allows team
 * reviewers (authorizeJobForReview).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob, authorizeJobForReview } from '../middleware/authorize-job.middleware';
import { rateLimiters } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { jobAcrobatReportUploadUrlSchema, jobAcrobatReportConfirmSchema } from '../schemas/job-acrobat-report.schemas';
import { acrobatReportController } from '../controllers/acrobat-report.controller';

const router = Router();

/** POST /api/v1/pdf/:jobId/acrobat-report/upload-url -- step 1 of 2: presigned PUT (text/html). */
router.post(
  '/:jobId/acrobat-report/upload-url',
  authenticate,
  authorizeJob,
  rateLimiters.styleGuideUpload,
  validate(jobAcrobatReportUploadUrlSchema),
  (req, res) => acrobatReportController.getUploadUrl(req, res),
);

/** POST /api/v1/pdf/:jobId/acrobat-report/confirm -- step 2 of 2: verify, parse, persist. */
router.post(
  '/:jobId/acrobat-report/confirm',
  authenticate,
  authorizeJob,
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
  authorizeJob,
  (req, res) => acrobatReportController.deleteReport(req, res),
);

export default router;
