import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { batchController } from '../controllers/batch.controller';
import {
  batchCreateSchema,
  batchStartSchema,
  batchListSchema,
  batchAcrGenerateSchema,
  batchExportSchema,
} from '../schemas/batch.schemas';

const router = Router();

const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 50,
  },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.epub')) {
      cb(null, true);
    } else {
      cb(new Error('Only EPUB files are allowed'));
    }
  },
});

router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchCreateSchema }),
  batchController.createBatch
);

router.post(
  '/:batchId/files',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchUpload.array('files', 50),
  batchController.uploadFiles
);

router.delete(
  '/:batchId/files/:fileId',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchController.removeFile
);

router.post(
  '/:batchId/start',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchStartSchema }),
  batchController.startBatch
);

router.get(
  '/:batchId',
  authenticate,
  batchController.getBatch
);

router.get(
  '/',
  authenticate,
  validate({ query: batchListSchema }),
  batchController.listBatches
);

router.post(
  '/:batchId/cancel',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchController.cancelBatch
);

router.post(
  '/:batchId/acr/generate',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchAcrGenerateSchema }),
  batchController.generateBatchAcr
);

router.post(
  '/:batchId/export',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchExportSchema }),
  batchController.exportBatch
);

router.post(
  '/:batchId/quick-fixes/apply',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchController.applyQuickFixes
);

router.get(
  '/:batchId/files/:fileId',
  authenticate,
  batchController.getBatchFile
);

router.get(
  '/:batchId/files/:fileId/download',
  authenticate,
  batchController.downloadBatchFile
);

export default router;
