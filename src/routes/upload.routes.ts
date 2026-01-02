import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getPresignedUploadUrl,
  confirmUpload,
  getPresignedDownloadUrl
} from '../controllers/upload.controller';

const router = Router();

router.use(authenticate);

router.post('/presign', getPresignedUploadUrl);
router.post('/:fileId/confirm', confirmUpload);
router.get('/:fileId/download', getPresignedDownloadUrl);

export default router;
