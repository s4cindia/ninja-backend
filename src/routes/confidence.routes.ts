import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { confidenceController } from '../controllers/confidence.controller';

const router = Router();

router.use(authenticate);

router.get('/summary', confidenceController.getDefaultConfidenceSummary.bind(confidenceController));
router.get('/criterion/:criterionId', confidenceController.getCriterionConfidence.bind(confidenceController));
router.get('/:jobId/with-issues', confidenceController.getConfidenceWithIssues.bind(confidenceController));
router.get('/job/:jobId/issues', confidenceController.getConfidenceWithIssues.bind(confidenceController)); // Legacy route for backwards compatibility

export default router;
