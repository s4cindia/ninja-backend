/**
 * Editor Routes
 * Handles OnlyOffice document editing integration
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { editorController } from '../controllers/editor/editor.controller';
import {
  createSessionSchema,
  sessionIdParamSchema,
  documentIdParamSchema,
} from '../schemas/editor.schemas';

const router = Router();

// ============================================
// Public routes (called by OnlyOffice server)
// ============================================

// OnlyOffice callback - no auth (OnlyOffice uses JWT in body/header)
// JWT verification is handled in the controller
router.post(
  '/callback',
  editorController.handleCallback.bind(editorController)
);

// Serve document to OnlyOffice - no auth (session validation in controller)
// Session state and expiry are validated in the controller
router.get(
  '/document/:sessionId',
  validate({ params: sessionIdParamSchema }),
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
  validate({ body: createSessionSchema }),
  editorController.createSession.bind(editorController)
);

// Get session info
router.get(
  '/session/:sessionId',
  validate({ params: sessionIdParamSchema }),
  editorController.getSession.bind(editorController)
);

// Close session
router.delete(
  '/session/:sessionId',
  validate({ params: sessionIdParamSchema }),
  editorController.closeSession.bind(editorController)
);

// Get active sessions for a document
router.get(
  '/document/:documentId/sessions',
  validate({ params: documentIdParamSchema }),
  editorController.getDocumentSessions.bind(editorController)
);

export default router;
