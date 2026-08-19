/**
 * Remediation Session Routes
 *
 * Idle/visibility-aware timing for an operator's Ninja remediation work,
 * mirroring the /calibration/runs/:runId/sessions/* shape.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { remediationSessionController } from '../controllers/remediation-session.controller';

const router = Router();

/**
 * POST /pdf/:jobId/remediation-session/start
 */
router.post(
  '/:jobId/remediation-session/start',
  authenticate,
  authorizeJob,
  (req, res) => remediationSessionController.startSession(req, res),
);

/**
 * POST /pdf/:jobId/remediation-session/:sessionId/end
 */
router.post(
  '/:jobId/remediation-session/:sessionId/end',
  authenticate,
  authorizeJob,
  (req, res) => remediationSessionController.endSession(req, res),
);

export default router;
