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
  getVersionParamsSchema,
} from '../schemas/validator.schemas';

const router = Router();

// Configure multer for DOCX uploads (in-memory for local dev)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (_req, file, cb) => {
    const isDocx =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.originalname.toLowerCase().endsWith('.docx');
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf');

    if (isDocx || isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only DOCX and PDF files are supported'));
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

/**
 * GET /api/v1/validator/documents/:documentId/content
 * Get document content as HTML for editing
 */
router.get(
  '/documents/:documentId/content',
  validate({ params: getDocumentParamsSchema }),
  validatorController.getDocumentContent.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents/:documentId/file
 * Get raw file (PDF or DOCX) for viewing/download
 */
router.get(
  '/documents/:documentId/file',
  validate({ params: getDocumentParamsSchema }),
  validatorController.getDocumentFile.bind(validatorController)
);

/**
 * PUT /api/v1/validator/documents/:documentId/content
 * Save document content (HTML)
 */
router.put(
  '/documents/:documentId/content',
  validate({ params: getDocumentParamsSchema }),
  validatorController.saveDocumentContent.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents/:documentId/versions
 * Get version history for a document
 */
router.get(
  '/documents/:documentId/versions',
  validate({ params: getDocumentParamsSchema }),
  validatorController.getDocumentVersions.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents/:documentId/versions/:versionId
 * Get a specific version's content
 */
router.get(
  '/documents/:documentId/versions/:versionId',
  validate({ params: getVersionParamsSchema }),
  validatorController.getDocumentVersion.bind(validatorController)
);

/**
 * POST /api/v1/validator/documents/:documentId/versions/:versionId/restore
 * Restore document to a specific version
 */
router.post(
  '/documents/:documentId/versions/:versionId/restore',
  validate({ params: getVersionParamsSchema }),
  validatorController.restoreDocumentVersion.bind(validatorController)
);

/**
 * GET /api/v1/validator/documents/:documentId/export
 * Export document as DOCX with formatting preserved
 */
router.get(
  '/documents/:documentId/export',
  validate({ params: getDocumentParamsSchema }),
  validatorController.exportDocument.bind(validatorController)
);

/**
 * POST /api/v1/validator/documents/:documentId/clear-cache
 * Clear cached HTML content to force re-conversion from original DOCX
 */
router.post(
  '/documents/:documentId/clear-cache',
  validate({ params: getDocumentParamsSchema }),
  validatorController.clearContentCache.bind(validatorController)
);

export default router;
