/**
 * PDF Remediation Routes
 *
 * REST API endpoints for PDF remediation workflow
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { validate } from '../middleware/validate.middleware';
import { pdfRemediationController } from '../controllers/pdf-remediation.controller';
import {
  createRemediationPlanSchema,
  getRemediationPlanSchema,
  updateTaskStatusSchema,
} from '../schemas/pdf-remediation.schemas';

const router = Router();

/**
 * POST /api/v1/pdf/:jobId/remediation/plan
 * Create a remediation plan from audit results
 *
 * @param jobId - PDF audit job ID
 * @returns RemediationPlan with tasks categorized by fix type
 */
router.post(
  '/:jobId/remediation/plan',
  authenticate,
  authorizeJob,
  validate(createRemediationPlanSchema),
  (req, res) => pdfRemediationController.createPlan(req, res)
);

/**
 * GET /api/v1/pdf/:jobId/remediation/plan
 * Get existing remediation plan
 *
 * @param jobId - PDF audit job ID
 * @returns RemediationPlan if exists, 404 if not found
 */
router.get(
  '/:jobId/remediation/plan',
  authenticate,
  authorizeJob,
  validate(getRemediationPlanSchema),
  (req, res) => pdfRemediationController.getPlan(req, res)
);

/**
 * PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId
 * Update task status (mark as completed, failed, skipped, etc.)
 *
 * @param jobId - PDF audit job ID
 * @param taskId - Task ID to update
 * @body status - New task status
 * @body errorMessage - Optional error message if status is FAILED
 * @body notes - Optional notes about the status change
 * @returns Updated task and plan summary
 */
router.patch(
  '/:jobId/remediation/tasks/:taskId',
  authenticate,
  authorizeJob,
  validate(updateTaskStatusSchema),
  (req, res) => pdfRemediationController.updateTaskStatus(req, res)
);

/**
 * POST /api/v1/pdf/:jobId/remediation/execute
 * Execute auto-remediation for all auto-fixable tasks
 *
 * @param jobId - PDF audit job ID
 * @returns AutoRemediationResult with modifications and remediated PDF URL
 */
router.post(
  '/:jobId/remediation/execute',
  authenticate,
  authorizeJob,
  (req, res) => pdfRemediationController.executeAutoRemediation(req, res)
);

export default router;
