/**
 * Validator Routes
 * Handles document upload and management for the Validator feature
 *
 * Note: These endpoints specifically serve the Validator workflow (direct editing).
 * While /citation-management/documents also queries EditorialDocument, that endpoint
 * is for the Citation Management workflow. Both share the same underlying table
 * but serve different features with different filtering and UI requirements.
 * Consider consolidating these endpoints if the distinction becomes unnecessary.
 */

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { validatorController } from '../controllers/validator/validator.controller';
import {
  listDocumentsQuerySchema,
  getDocumentParamsSchema,
} from '../schemas/validator.schemas';

const router = Router();

// Configure multer for DOCX uploads (in-memory for local dev)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.originalname.toLowerCase().endsWith('.docx')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only DOCX files are allowed'));
    }
  },
});

// Apply authentication to all routes
router.use(authenticate);

/**
 * POST /api/v1/validator/upload
 * Upload a DOCX file for editing in the Validator
 */
router.post(
  '/upload',
  upload.single('file'),
  validatorController.upload.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents
 * List all documents for the current user
 */
router.get(
  '/documents',
  validate({ query: listDocumentsQuerySchema }),
  validatorController.listDocuments.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents/:documentId
 * Get document details
 */
router.get(
  '/documents/:documentId',
  validate({ params: getDocumentParamsSchema }),
  validatorController.getDocument.bind(validatorController)
);

export default router;
