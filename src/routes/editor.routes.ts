/**
 * Editor Routes
 * Handles OnlyOffice document editing integration
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { editorController } from '../controllers/editor/editor.controller';
import {
  createSessionSchema,
  sessionIdParamSchema,
  documentIdParamSchema,
} from '../schemas/editor.schemas';

const router = Router();

// Rate limiter for public callback endpoint (unauthenticated)
// Prevents abuse from single IP while allowing legitimate OnlyOffice callbacks
const callbackRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP (OnlyOffice may send multiple callbacks)
  message: { error: 1 }, // OnlyOffice expects { error: 0 } or { error: 1 }
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for document serving (prevents enumeration attacks)
const serveDocumentRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Public routes (called by OnlyOffice server)
// ============================================

// OnlyOffice callback - no auth (OnlyOffice uses JWT in body/header)
// JWT verification is handled in the controller
// Rate limited to prevent abuse
router.post(
  '/callback',
  callbackRateLimiter,
  editorController.handleCallback.bind(editorController)
);

// Serve document to OnlyOffice - no auth (session validation in controller)
// Session state and expiry are validated in the controller
// Rate limited to prevent enumeration attacks
router.get(
  '/document/:sessionId',
  serveDocumentRateLimiter,
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
