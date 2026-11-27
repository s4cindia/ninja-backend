/**
 * Certification routes (EPUB-from-certified-PDF, B3a).
 * Certify/revoke: owner, ADMIN or the owner's Team Leader
 * (authorizeJobForTeamLeaderAction -- checked at action time against the
 * current team). Read: also team reviewers.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJobForReview, authorizeJobForTeamLeaderAction } from '../middleware/authorize-job.middleware';
import { validate } from '../middleware/validate.middleware';
import { certifyJobSchema, revokeCertificationSchema } from '../schemas/certification.schemas';
import { certificationController } from '../controllers/certification.controller';

const router = Router();

/** POST /api/v1/pdf/:jobId/certification/revoke -- registered before the bare path. */
router.post(
  '/:jobId/certification/revoke',
  authenticate,
  authorizeJobForTeamLeaderAction,
  validate(revokeCertificationSchema),
  (req, res) => certificationController.revoke(req, res),
);

/** POST /api/v1/pdf/:jobId/certification */
router.post(
  '/:jobId/certification',
  authenticate,
  authorizeJobForTeamLeaderAction,
  validate(certifyJobSchema),
  (req, res) => certificationController.certify(req, res),
);

/** GET /api/v1/pdf/:jobId/certification -- current (re-validated) + history. */
router.get(
  '/:jobId/certification',
  authenticate,
  authorizeJobForReview,
  (req, res) => certificationController.get(req, res),
);

export default router;
