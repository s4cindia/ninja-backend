import { Router } from 'express';
import { complianceController } from '../controllers/compliance.controller';

const router = Router();

router.post('/section508/map', (req, res, next) => complianceController.mapSection508(req, res, next));

router.post('/section508/map-by-job', (req, res, next) => complianceController.mapSection508ByJobId(req, res, next));

export default router;
