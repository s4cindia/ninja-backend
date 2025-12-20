import { Router } from 'express';
import { feedbackController } from '../controllers/feedback.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', feedbackController.create);

router.post('/quick-rating', feedbackController.quickRating);

router.get('/', feedbackController.list);

router.get('/job/:jobId', feedbackController.getJobFeedback);

router.get('/dashboard/stats', feedbackController.getStats);
router.get('/dashboard/trends', feedbackController.getTrends);
router.get('/dashboard/top-issues', feedbackController.getTopIssues);
router.get('/dashboard/requiring-attention', feedbackController.getRequiringAttention);

router.get('/:id', feedbackController.getById);

router.patch('/:id', feedbackController.updateStatus);

export default router;
