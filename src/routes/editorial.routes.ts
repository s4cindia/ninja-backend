import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { editorialOverviewController } from '../controllers/editorial-overview.controller';

const router = Router();

router.use(authenticate);

router.get(
  '/documents',
  editorialOverviewController.listDocuments.bind(editorialOverviewController)
);

router.get(
  '/document/:documentId/overview',
  editorialOverviewController.getDocumentOverview.bind(editorialOverviewController)
);

export default router;
