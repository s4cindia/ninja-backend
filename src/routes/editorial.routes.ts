import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { editorialOverviewController } from '../controllers/editorial-overview.controller';

const router = Router();
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(authenticate);

router.get(
  '/documents',
  editorialOverviewController.listDocuments.bind(editorialOverviewController)
);

router.get(
  '/document/:documentId/overview',
  editorialOverviewController.getDocumentOverview.bind(editorialOverviewController)
);

router.get(
  '/document/:documentId/text',
  editorialOverviewController.getDocumentText.bind(editorialOverviewController)
);

router.post(
  '/document/:documentId/regenerate-html',
  memoryUpload.single('file'),
  editorialOverviewController.regenerateHtml.bind(editorialOverviewController)
);

router.get(
  '/document/:documentId/reference-lookup',
  editorialOverviewController.getReferenceLookup.bind(editorialOverviewController)
);

router.get(
  '/document/:documentId/validate-citations',
  editorialOverviewController.runCitationValidation.bind(editorialOverviewController)
);

export default router;
