import { Router } from 'express';
import { getDashboardStats, getDashboardActivity } from '../controllers/dashboard.controller';

const router = Router();

router.get('/stats', getDashboardStats);
router.get('/activity', getDashboardActivity);

export default router;
