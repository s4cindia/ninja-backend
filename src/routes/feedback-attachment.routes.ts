import { Router } from 'express';
import multer from 'multer';
import { FeedbackAttachmentController } from '../controllers/feedback-attachment.controller';
import { FeedbackAttachmentService } from '../services/feedback/attachment.service';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';
import { s3Client } from '../services/s3.service';
import { config } from '../config';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const service = new FeedbackAttachmentService(prisma, s3Client, config.s3Bucket);
const controller = new FeedbackAttachmentController(service);

const router = Router();

router.get('/attachments/:id/download', authenticate, controller.download);
router.get('/attachments/:id/file', authenticate, controller.serveLocalFile);
router.delete('/attachments/:id', authenticate, controller.delete);

router.post('/:feedbackId/attachments/presign', authenticate, controller.getPresignedUrl);
router.post('/:feedbackId/attachments/confirm', authenticate, controller.confirmUpload);

router.post('/:feedbackId/attachments', authenticate, upload.array('files', 5), controller.upload);
router.get('/:feedbackId/attachments', authenticate, controller.list);

export default router;
