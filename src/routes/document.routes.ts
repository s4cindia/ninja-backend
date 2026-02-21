/**
 * Document Routes
 * Handles document versioning and track changes endpoints
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { documentVersionController } from '../controllers/document/document-version.controller';
import { trackChangesController } from '../controllers/document/track-changes.controller';
import {
  createVersionSchema,
  compareVersionsQuerySchema,
  createChangeSchema,
  bulkActionSchema,
  changesQuerySchema,
  versionsQuerySchema,
} from '../schemas/document.schemas';
import { z } from 'zod';

const router = Router();

// Common param schemas
const documentIdParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
});

const versionParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
  version: z.string().regex(/^\d+$/, 'Version must be a number'),
});

const changeIdParamSchema = z.object({
  changeId: z.string().uuid('Invalid change ID'),
});

// Apply authentication to all routes
router.use(authenticate);

// ============================================
// Document Version Routes
// ============================================

// List all versions
router.get(
  '/:documentId/versions',
  validate({ params: documentIdParamSchema, query: versionsQuerySchema }),
  documentVersionController.listVersions.bind(documentVersionController)
);

// Get latest version
router.get(
  '/:documentId/versions/latest',
  validate({ params: documentIdParamSchema }),
  documentVersionController.getLatestVersion.bind(documentVersionController)
);

// Compare versions
router.get(
  '/:documentId/versions/compare',
  validate({ params: documentIdParamSchema, query: compareVersionsQuerySchema }),
  documentVersionController.compareVersions.bind(documentVersionController)
);

// Get specific version
router.get(
  '/:documentId/versions/:version',
  validate({ params: versionParamSchema }),
  documentVersionController.getVersion.bind(documentVersionController)
);

// Create new version (manual snapshot)
router.post(
  '/:documentId/versions',
  validate({ params: documentIdParamSchema, body: createVersionSchema }),
  documentVersionController.createVersion.bind(documentVersionController)
);

// Restore to version
router.post(
  '/:documentId/versions/:version/restore',
  validate({ params: versionParamSchema }),
  documentVersionController.restoreVersion.bind(documentVersionController)
);

// ============================================
// Track Changes Routes
// ============================================

// List all changes
router.get(
  '/:documentId/changes',
  validate({ params: documentIdParamSchema, query: changesQuerySchema }),
  trackChangesController.listChanges.bind(trackChangesController)
);

// List pending changes
router.get(
  '/:documentId/changes/pending',
  validate({ params: documentIdParamSchema }),
  trackChangesController.listPendingChanges.bind(trackChangesController)
);

// Get change statistics
router.get(
  '/:documentId/changes/stats',
  validate({ params: documentIdParamSchema }),
  trackChangesController.getChangeStats.bind(trackChangesController)
);

// Create a change
router.post(
  '/:documentId/changes',
  validate({ params: documentIdParamSchema, body: createChangeSchema }),
  trackChangesController.createChange.bind(trackChangesController)
);

// Bulk accept/reject
router.post(
  '/:documentId/changes/bulk',
  validate({ params: documentIdParamSchema, body: bulkActionSchema }),
  trackChangesController.bulkAction.bind(trackChangesController)
);

// Accept all pending
router.post(
  '/:documentId/changes/accept-all',
  validate({ params: documentIdParamSchema }),
  trackChangesController.acceptAllPending.bind(trackChangesController)
);

// Reject all pending
router.post(
  '/:documentId/changes/reject-all',
  validate({ params: documentIdParamSchema }),
  trackChangesController.rejectAllPending.bind(trackChangesController)
);

// Accept single change
router.patch(
  '/change/:changeId/accept',
  validate({ params: changeIdParamSchema }),
  trackChangesController.acceptChange.bind(trackChangesController)
);

// Reject single change
router.patch(
  '/change/:changeId/reject',
  validate({ params: changeIdParamSchema }),
  trackChangesController.rejectChange.bind(trackChangesController)
);

export default router;
