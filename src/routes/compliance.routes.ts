import { Router } from 'express';
import { complianceController } from '../controllers/compliance.controller';

const router = Router();

router.post('/section508/map', (req, res, next) => complianceController.mapSection508(req, res, next));

router.post('/section508/map-by-job', (req, res, next) => complianceController.mapSection508ByJobId(req, res, next));

router.post('/fpc/validate', (req, res, next) => complianceController.validateFpc(req, res, next));
router.post('/fpc/validate/:criterionId', (req, res, next) => complianceController.validateFpcCriterion(req, res, next));
router.get('/fpc/definitions', (req, res, next) => complianceController.getFpcDefinitions(req, res, next));

router.post('/documentation/validate', (req, res, next) => complianceController.validateDocumentation(req, res, next));
router.get('/documentation/requirements', (req, res, next) => complianceController.getDocumentationRequirements(req, res, next));
router.get('/documentation/checklist', (req, res, next) => complianceController.getDocumentationChecklist(req, res, next));

export default router;
