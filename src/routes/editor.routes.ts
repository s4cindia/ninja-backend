/**
 * Editor Routes
 * Handles OnlyOffice document editing integration
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { editorController } from '../controllers/editor/editor.controller';

const router = Router();

// ============================================
// Public routes (called by OnlyOffice server)
// ============================================

// OnlyOffice callback - no auth (OnlyOffice uses JWT in body/header)
router.post(
  '/callback',
  editorController.handleCallback.bind(editorController)
);

// Serve document to OnlyOffice - no auth (session ID is validated)
router.get(
  '/document/:sessionId',
  editorController.serveDocument.bind(editorController)
);

// ============================================
// Protected routes (require authentication)
// ============================================

router.use(authenticate);

// Check OnlyOffice status
router.get(
  '/status',
  editorController.getStatus.bind(editorController)
);

// Create editing session
router.post(
  '/session',
  editorController.createSession.bind(editorController)
);

// Get session info
router.get(
  '/session/:sessionId',
  editorController.getSession.bind(editorController)
);

// Close session
router.delete(
  '/session/:sessionId',
  editorController.closeSession.bind(editorController)
);

// Get active sessions for a document
router.get(
  '/document/:documentId/sessions',
  editorController.getDocumentSessions.bind(editorController)
);

export default router;
