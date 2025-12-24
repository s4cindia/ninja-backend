import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { acrController } from '../controllers/acr.controller';
import { verificationController } from '../controllers/verification.controller';

const router = Router();

router.use(authenticate);

router.get('/analysis/:jobId', acrController.getAnalysis.bind(acrController));
router.post('/generate', acrController.generateAcr.bind(acrController));
router.post('/generate-remarks', acrController.generateRemarks.bind(acrController));
router.get('/editions', acrController.getEditions.bind(acrController));
router.get('/editions/:edition', acrController.getEditionInfo.bind(acrController));
router.get('/remarks-requirements', acrController.getRemarksRequirements.bind(acrController));
router.get('/analysis/:jobId', authorizeJob, acrController.getAnalysis.bind(acrController));
router.post('/:jobId/validate-credibility', acrController.validateCredibility.bind(acrController));
router.get('/:jobId/can-finalize', verificationController.canFinalize.bind(verificationController));
router.get('/:jobId/methodology', acrController.getMethodology.bind(acrController));
router.post('/:acrId/export', acrController.exportAcr.bind(acrController));

router.get('/:acrId/versions', acrController.getVersions.bind(acrController));
router.post('/:acrId/versions', acrController.createVersion.bind(acrController));
router.get('/:acrId/versions/:version', acrController.getVersion.bind(acrController));
router.get('/:acrId/compare', acrController.compareVersions.bind(acrController));

export default router;
