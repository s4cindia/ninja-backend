import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { acrController } from '../controllers/acr.controller';
import { verificationController } from '../controllers/verification.controller';

const router = Router();

router.use(authenticate);

router.post('/generate', acrController.generateAcr.bind(acrController));
router.get('/editions', acrController.getEditions.bind(acrController));
router.get('/editions/:edition', acrController.getEditionInfo.bind(acrController));
router.get('/remarks-requirements', acrController.getRemarksRequirements.bind(acrController));
router.post('/:jobId/validate-credibility', acrController.validateCredibility.bind(acrController));
router.get('/:jobId/can-finalize', verificationController.canFinalize.bind(verificationController));

export default router;
