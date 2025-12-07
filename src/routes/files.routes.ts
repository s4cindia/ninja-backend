import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { uploadSingle } from '../middleware/upload.middleware';
import { fileController } from '../controllers/file.controller';

const router = Router();

router.post('/upload', authenticate, uploadSingle, fileController.upload.bind(fileController));

router.get('/', authenticate, fileController.listFiles.bind(fileController));

router.get('/:id', authenticate, fileController.getFile.bind(fileController));

router.get('/:id/download', authenticate, fileController.downloadFile.bind(fileController));

router.delete('/:id', authenticate, fileController.deleteFile.bind(fileController));

export default router;
