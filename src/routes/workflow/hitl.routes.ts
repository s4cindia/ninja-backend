import { Router } from 'express';
import { hitlController } from '../../controllers/workflow/hitl.controller';
import { authenticate } from '../../middleware/auth.middleware';

const router = Router();

// All HITL routes require authentication
router.use(authenticate);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/ai-review/approve
 * @desc Approve AI analysis review
 * @access Private
 */
router.post('/:workflowId/ai-review/approve', (req, res) =>
  hitlController.approveAiReview(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/ai-review/reject
 * @desc Reject AI analysis review
 * @access Private
 */
router.post('/:workflowId/ai-review/reject', (req, res) =>
  hitlController.rejectAiReview(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/remediation-review/approve
 * @desc Approve remediation review
 * @access Private
 */
router.post('/:workflowId/remediation-review/approve', (req, res) =>
  hitlController.approveRemediationReview(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/conformance-review/approve
 * @desc Approve conformance review
 * @access Private
 */
router.post('/:workflowId/conformance-review/approve', (req, res) =>
  hitlController.approveConformanceReview(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/acr-signoff
 * @desc Sign off ACR (final approval)
 * @access Private
 */
router.post('/:workflowId/acr-signoff', (req, res) =>
  hitlController.signoffAcr(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/pause
 * @desc Pause workflow at current state
 * @access Private
 */
router.post('/:workflowId/pause', (req, res) =>
  hitlController.pauseWorkflow(req, res)
);

/**
 * @route POST /api/v1/workflow/hitl/:workflowId/resume
 * @desc Resume paused workflow
 * @access Private
 */
router.post('/:workflowId/resume', (req, res) =>
  hitlController.resumeWorkflow(req, res)
);

export default router;
