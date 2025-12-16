import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { acrController } from '../controllers/acr.controller';

const router = Router();

router.use(authenticate);

router.post('/generate', acrController.generateAcr.bind(acrController));
router.get('/editions', acrController.getEditions.bind(acrController));
router.get('/editions/:edition', acrController.getEditionInfo.bind(acrController));

export default router;
