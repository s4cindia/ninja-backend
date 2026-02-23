import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { workflowController } from '../controllers/workflow.controller';

const router = Router();

router.use(authenticate);

// Batch routes MUST come before /:id to avoid Express matching 'batch' as an id param
router.post('/batch', workflowController.startBatch.bind(workflowController));
router.get('/batch/:batchId', workflowController.getBatchDashboard.bind(workflowController));
router.post('/batch/:batchId/pause', workflowController.pauseBatch.bind(workflowController));
router.post('/batch/:batchId/resume', workflowController.resumeBatch.bind(workflowController));
router.post('/batch/:batchId/retry-failed', workflowController.retryFailedBatch.bind(workflowController));

// Workflow CRUD & lifecycle
router.post('/', workflowController.startWorkflow.bind(workflowController));
router.get('/:id', workflowController.getWorkflowStatus.bind(workflowController));
router.post('/:id/pause', workflowController.pauseWorkflow.bind(workflowController));
router.post('/:id/resume', workflowController.resumeWorkflow.bind(workflowController));
router.post('/:id/cancel', workflowController.cancelWorkflow.bind(workflowController));
router.post('/:id/retry', workflowController.retryWorkflow.bind(workflowController));
router.get('/:id/timeline', workflowController.getTimeline.bind(workflowController));

// HITL gates
router.post('/:id/hitl/ai-review', workflowController.submitAIReview.bind(workflowController));
router.post('/:id/hitl/remediation-fix', workflowController.submitRemediationFix.bind(workflowController));
router.post('/:id/hitl/remediation-review', workflowController.submitRemediationReview.bind(workflowController));
router.post('/:id/hitl/conformance-review', workflowController.submitConformanceReview.bind(workflowController));
router.post('/:id/hitl/acr-signoff', workflowController.submitACRSignoff.bind(workflowController));

export default router;
