import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { jobController } from '../controllers/job.controller';
import { confidenceController } from '../controllers/confidence.controller';
import { createJobSchema, listJobsSchema } from '../schemas/job.schemas';

const router = Router();

router.use(authenticate);

router.get('/', validate(listJobsSchema), (req, res, next) => 
  jobController.list(req, res, next)
);

router.get('/stats', (req, res, next) => 
  jobController.getStats(req, res, next)
);

router.post('/', validate(createJobSchema), (req, res, next) => 
  jobController.create(req, res, next)
);

router.get('/:id', (req, res, next) => 
  jobController.get(req, res, next)
);

router.get('/:id/status', (req, res, next) => 
  jobController.getStatus(req, res, next)
);

router.get('/:id/results', (req, res, next) => 
  jobController.getResults(req, res, next)
);

router.get('/:id/confidence-summary', (req, res, next) =>
  confidenceController.getConfidenceSummary(req, res, next)
);

router.delete('/:id', (req, res, next) => 
  jobController.cancel(req, res, next)
);

export default router;
