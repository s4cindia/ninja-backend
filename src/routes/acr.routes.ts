import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob, authorizeAcr } from '../middleware/authorize-job.middleware';
import { acrController } from '../controllers/acr.controller';
import { verificationController } from '../controllers/verification.controller';

const router = Router();

router.use(authenticate);

router.get('/analysis/:jobId', acrController.getAnalysis.bind(acrController));
router.post('/generate', acrController.generateAcr.bind(acrController));
router.post('/generate-remarks', acrController.generateRemarks.bind(acrController));
router.get('/editions', acrController.getAllEditions.bind(acrController));
router.get('/editions/:editionCode/criteria', acrController.getEditionCriteria.bind(acrController));
router.get('/criteria/:criterionId', acrController.getCriterion.bind(acrController));
router.get('/editions/:edition', acrController.getEditionInfo.bind(acrController));
router.get('/remarks-requirements', acrController.getRemarksRequirements.bind(acrController));
router.post('/:jobId/validate-credibility', authorizeJob, acrController.validateCredibility.bind(acrController));
router.get('/:jobId/can-finalize', authorizeJob, verificationController.canFinalize.bind(verificationController));
router.get('/:jobId/methodology', authorizeJob, acrController.getMethodology.bind(acrController));
router.post('/:acrId/export', authorizeAcr, acrController.exportAcr.bind(acrController));

router.get('/:acrId/versions', authorizeAcr, acrController.getVersions.bind(acrController));
router.post('/:acrId/versions', authorizeAcr, acrController.createVersion.bind(acrController));
router.get('/:acrId/versions/:version', authorizeAcr, acrController.getVersion.bind(acrController));
router.get('/:acrId/compare', authorizeAcr, acrController.compareVersions.bind(acrController));

router.post('/analysis', acrController.createAnalysis.bind(acrController));
router.get('/job/:jobId/analysis', acrController.getAcrAnalysisByJobId.bind(acrController));
router.get('/:acrJobId', acrController.getAcrAnalysis.bind(acrController));
router.get('/:acrJobId/analysis', acrController.getAcrAnalysis.bind(acrController));
router.post('/:acrJobId/criteria/:criterionId/review', acrController.saveCriterionReview.bind(acrController));
router.get('/:acrJobId/criteria/:criterionId', acrController.getCriterionDetailsFromJob.bind(acrController));
router.post('/:acrJobId/reviews/bulk', acrController.saveBulkReviews.bind(acrController));

router.get('/criterion-guidance', acrController.getCriterionGuidance.bind(acrController));

export default router;
