import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getDashboardStats, getDashboardActivity } from '../controllers/dashboard.controller';

const router = Router();

router.use(authenticate);

router.get('/stats', getDashboardStats);
router.get('/activity', getDashboardActivity);

export default router;
