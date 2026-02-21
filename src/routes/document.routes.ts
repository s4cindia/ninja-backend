/**
 * Document Routes
 * Handles document versioning and track changes endpoints
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { documentVersionController } from '../controllers/document/document-version.controller';
import { trackChangesController } from '../controllers/document/track-changes.controller';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// ============================================
// Document Version Routes
// ============================================

// List all versions
router.get(
  '/:documentId/versions',
  documentVersionController.listVersions.bind(documentVersionController)
);

// Get latest version
router.get(
  '/:documentId/versions/latest',
  documentVersionController.getLatestVersion.bind(documentVersionController)
);

// Compare versions
router.get(
  '/:documentId/versions/compare',
  documentVersionController.compareVersions.bind(documentVersionController)
);

// Get specific version
router.get(
  '/:documentId/versions/:version',
  documentVersionController.getVersion.bind(documentVersionController)
);

// Create new version (manual snapshot)
router.post(
  '/:documentId/versions',
  documentVersionController.createVersion.bind(documentVersionController)
);

// Restore to version
router.post(
  '/:documentId/versions/:version/restore',
  documentVersionController.restoreVersion.bind(documentVersionController)
);

// ============================================
// Track Changes Routes
// ============================================

// List all changes
router.get(
  '/:documentId/changes',
  trackChangesController.listChanges.bind(trackChangesController)
);

// List pending changes
router.get(
  '/:documentId/changes/pending',
  trackChangesController.listPendingChanges.bind(trackChangesController)
);

// Get change statistics
router.get(
  '/:documentId/changes/stats',
  trackChangesController.getChangeStats.bind(trackChangesController)
);

// Create a change
router.post(
  '/:documentId/changes',
  trackChangesController.createChange.bind(trackChangesController)
);

// Bulk accept/reject
router.post(
  '/:documentId/changes/bulk',
  trackChangesController.bulkAction.bind(trackChangesController)
);

// Accept all pending
router.post(
  '/:documentId/changes/accept-all',
  trackChangesController.acceptAllPending.bind(trackChangesController)
);

// Reject all pending
router.post(
  '/:documentId/changes/reject-all',
  trackChangesController.rejectAllPending.bind(trackChangesController)
);

// Accept single change
router.patch(
  '/change/:changeId/accept',
  trackChangesController.acceptChange.bind(trackChangesController)
);

// Reject single change
router.patch(
  '/change/:changeId/reject',
  trackChangesController.rejectChange.bind(trackChangesController)
);

export default router;
