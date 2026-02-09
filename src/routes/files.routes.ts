import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { uploadSingle } from '../middleware/upload.middleware';
import { validate } from '../middleware/validate.middleware';
import { fileController } from '../controllers/file.controller';
import {
  listFilesSchema,
  fileIdParamSchema,
  updateFileStatusSchema,
} from '../schemas/file.schemas';
import { logger } from '../lib/logger';

const router = Router();

const debugUpload = (req: Request, res: Response, next: NextFunction) => {
  logger.debug(`[Upload Route] Before uploadSingle: hasUser=${!!req.user}, contentType=${req.headers['content-type']}, contentLength=${req.headers['content-length']}`);
  next();
};

// Static routes first
router.post('/upload', authenticate, debugUpload, uploadSingle, fileController.upload.bind(fileController));
router.get('/', authenticate, validate(listFilesSchema), fileController.listAdvanced.bind(fileController));
router.get('/stats', authenticate, fileController.getStats.bind(fileController));

// Bulk operations (must come BEFORE /:id routes)
router.post('/bulk/delete', authenticate, fileController.bulkDelete.bind(fileController));
router.post('/bulk/audit', authenticate, fileController.bulkAudit.bind(fileController));

// Parameterized routes last
router.get('/:id', authenticate, validate(fileIdParamSchema), fileController.getFile.bind(fileController));
router.get('/:id/download', authenticate, validate(fileIdParamSchema), fileController.downloadFile.bind(fileController));
router.get('/:id/artifacts', authenticate, validate(fileIdParamSchema), fileController.getFileArtifacts.bind(fileController));
router.patch('/:id/status', authenticate, validate(updateFileStatusSchema), fileController.updateStatus.bind(fileController));
router.delete('/:id', authenticate, validate(fileIdParamSchema), fileController.deleteFile.bind(fileController));
router.post('/:id/audit', authenticate, validate(fileIdParamSchema), fileController.triggerAudit.bind(fileController));

export default router;
