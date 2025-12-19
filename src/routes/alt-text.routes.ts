import { Router } from 'express';
import { altTextController } from '../controllers/alt-text.controller';
import { authenticate } from '../middleware/auth.middleware';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate);

router.post('/generate', altTextController.generate);

router.post('/generate-from-buffer', upload.single('image'), altTextController.generateFromBuffer);

router.post('/job/:jobId/generate', altTextController.generateForJob);

router.get('/job/:jobId', altTextController.getForJob);

router.patch('/:id', altTextController.updateAltText);

export default router;
