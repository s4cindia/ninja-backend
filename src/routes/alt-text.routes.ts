import { Router } from 'express';
import { altTextController } from '../controllers/alt-text.controller';
import { authenticate } from '../middleware/auth.middleware';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate);

router.post('/generate', altTextController.generate);

router.post('/generate-contextual', altTextController.generateContextual);

router.post('/generate-chart', altTextController.generateChartDescription);

router.post('/classify', altTextController.classifyImage);

router.post('/generate-from-buffer', upload.single('image'), altTextController.generateFromBuffer);

router.post('/job/:jobId/generate', altTextController.generateForJob);

router.get('/job/:jobId', altTextController.getForJob);

router.get('/job/:jobId/review-queue', altTextController.getReviewQueue);

router.post('/job/:jobId/batch-approve', altTextController.batchApprove);

router.get('/:id', altTextController.getById);

router.patch('/:id', altTextController.updateAltText);

router.post('/:id/approve', altTextController.approve);

router.post('/:id/reject', altTextController.reject);

router.post('/:id/regenerate', altTextController.regenerate);

router.get('/:id/long-description/check', altTextController.checkLongDescriptionNeeded);

router.post('/:id/long-description', altTextController.generateLongDescription);

router.get('/:id/long-description', altTextController.getLongDescription);

router.patch('/long-description/:id', altTextController.updateLongDescription);

export default router;
