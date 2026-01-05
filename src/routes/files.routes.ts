import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { uploadSingle } from '../middleware/upload.middleware';
import { validate } from '../middleware/validate.middleware';
import { fileController } from '../controllers/file.controller';
import {
  listFilesSchema,
  fileIdParamSchema,
  updateFileStatusSchema,
} from '../schemas/file.schemas';

const router = Router();

router.post('/upload', authenticate, uploadSingle, fileController.upload.bind(fileController));

router.get('/', authenticate, validate(listFilesSchema), fileController.listAdvanced.bind(fileController));

router.get('/stats', authenticate, fileController.getStats.bind(fileController));

router.get('/:id', authenticate, validate(fileIdParamSchema), fileController.getFile.bind(fileController));

router.get('/:id/download', authenticate, validate(fileIdParamSchema), fileController.downloadFile.bind(fileController));

router.patch('/:id/status', authenticate, validate(updateFileStatusSchema), fileController.updateStatus.bind(fileController));

router.delete('/:id', authenticate, validate(fileIdParamSchema), fileController.deleteFile.bind(fileController));

router.post('/:id/audit', authenticate, validate(fileIdParamSchema), fileController.triggerAudit.bind(fileController));

export default router;
