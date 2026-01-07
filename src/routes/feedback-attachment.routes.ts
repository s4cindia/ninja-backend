import { Router } from 'express';
import multer from 'multer';
import { FeedbackAttachmentController } from '../controllers/feedback-attachment.controller';
import { FeedbackAttachmentService } from '../services/feedback/attachment.service';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';
import { s3Client } from '../services/s3.service';
import { config } from '../config';
import { logger } from '../lib/logger';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const bucketName = config.s3Bucket || 'feedback-attachments-local';
if (!config.s3Bucket) {
  logger.warn('S3_BUCKET not configured, using local storage fallback');
}

const service = new FeedbackAttachmentService(prisma, s3Client, bucketName);
const controller = new FeedbackAttachmentController(service);

const router = Router();

router.get('/attachments/:id/download', authenticate, controller.download);
router.get('/attachments/:id/file', authenticate, controller.serveLocalFile);
router.delete('/attachments/:id', authenticate, controller.delete);

router.post('/:feedbackId/attachments', authenticate, upload.array('files', 5), controller.upload);
router.get('/:feedbackId/attachments', authenticate, controller.list);

export default router;
