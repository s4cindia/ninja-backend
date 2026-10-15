import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { pdfBatchController } from '../controllers/pdf-batch.controller';
import {
  pdfBatchCreateSchema,
  pdfBatchAddItemsSchema,
  pdfBatchListSchema,
} from '../schemas/pdf-batch.schemas';

const router = Router();

// No file bytes ever flow through these routes -- items reference an
// already-uploaded, already-confirmed File row by id (via
// POST /uploads/presign + POST /uploads/:fileId/confirm), not a multipart
// upload. See pdf-batch.controller.ts's module doc comment.

router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: pdfBatchCreateSchema }),
  pdfBatchController.createBatch.bind(pdfBatchController)
);

router.post(
  '/:batchId/items',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: pdfBatchAddItemsSchema }),
  pdfBatchController.addItems.bind(pdfBatchController)
);

router.delete(
  '/:batchId/items/:itemId',
  authenticate,
  authorize('ADMIN', 'USER'),
  pdfBatchController.removeItem.bind(pdfBatchController)
);

router.post(
  '/:batchId/start',
  authenticate,
  authorize('ADMIN', 'USER'),
  pdfBatchController.startBatch.bind(pdfBatchController)
);

router.post(
  '/:batchId/cancel',
  authenticate,
  authorize('ADMIN', 'USER'),
  pdfBatchController.cancelBatch.bind(pdfBatchController)
);

router.get(
  '/:batchId',
  authenticate,
  pdfBatchController.getBatch.bind(pdfBatchController)
);

router.get(
  '/',
  authenticate,
  validate({ query: pdfBatchListSchema }),
  pdfBatchController.listBatches.bind(pdfBatchController)
);

export default router;
