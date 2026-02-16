/**
 * Citation Management Routes
 * Comprehensive citation tool API
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { citationManagementController } from '../controllers/citation';
import {
  documentIdParamSchema,
  jobIdParamSchema,
  documentReferenceParamsSchema,
  reorderReferencesSchema,
  editReferenceSchema,
  convertStyleSchema,
  debugStyleConversionSchema,
  exportDocumentSchema,
  previewChangesSchema,
  validateDoisSchema,
} from '../schemas/citation.schemas';

// Rate limiter for file uploads: 10 uploads per 15 minutes per user
// Note: All routes require authentication (router.use(authenticate)), so user is always present
const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: {
    success: false,
    error: { code: 'TOO_MANY_UPLOADS', message: 'Too many uploads. Please try again later.' }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use authenticated user ID for rate limiting
    const userReq = req as Request & { user?: { id: string } };
    return userReq.user?.id || 'unauthenticated'; // Should never be 'unauthenticated' due to auth middleware
  }
});

// Rate limiter for document exports: 30 exports per 15 minutes per user
// More generous than uploads since exports are read-only operations
const exportRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per window
  message: {
    success: false,
    error: { code: 'TOO_MANY_EXPORTS', message: 'Too many export requests. Please try again later.' }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use authenticated user ID for rate limiting
    const userReq = req as Request & { user?: { id: string } };
    return userReq.user?.id || 'unauthenticated'; // Should never be 'unauthenticated' due to auth middleware
  }
});

const router = Router();

// Configure multer for DOCX uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only DOCX files are allowed'));
    }
  },
});

// All routes require authentication
router.use(authenticate);

// ============================================
// DEBUG ENDPOINTS (disabled in production, require auth)
// ============================================

// Middleware to block debug endpoints in production
const blockInProduction = (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error: { code: 'DEBUG_DISABLED', message: 'Debug endpoints are disabled in production' }
    });
  }
  next();
};

/**
 * GET /api/v1/citation-management/document/:documentId/export-debug
 * Debug endpoint to check document state before export (DEVELOPMENT ONLY)
 */
router.get(
  '/document/:documentId/export-debug',
  blockInProduction,
  validate(documentIdParamSchema),
  citationManagementController.exportDebug.bind(citationManagementController)
);

/**
 * POST /api/v1/citation-management/document/:documentId/debug-style-conversion
 * Debug endpoint to test style conversion (DEVELOPMENT ONLY)
 */
router.post(
  '/document/:documentId/debug-style-conversion',
  blockInProduction,
  validate(debugStyleConversionSchema),
  citationManagementController.debugStyleConversion.bind(citationManagementController)
);

/**
 * POST /api/v1/citation-management/document/:documentId/reanalyze
 * Re-analyze document with auto-resequencing (DEVELOPMENT ONLY)
 */
router.post(
  '/document/:documentId/reanalyze',
  blockInProduction,
  validate(documentIdParamSchema),
  citationManagementController.reanalyze.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/document/:documentId/preview-debug
 * Debug preview endpoint (DEVELOPMENT ONLY)
 */
router.get(
  '/document/:documentId/preview-debug',
  blockInProduction,
  validate(documentIdParamSchema),
  citationManagementController.previewChanges.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/document/:documentId/export-debug-docx
 * Debug export endpoint (DEVELOPMENT ONLY)
 */
router.get(
  '/document/:documentId/export-debug-docx',
  blockInProduction,
  validate(exportDocumentSchema),
  citationManagementController.exportDocument.bind(citationManagementController)
);

// ============================================
// DOCUMENT MANAGEMENT
// ============================================

/**
 * POST /api/v1/citation-management/upload
 * Upload DOCX and start AI analysis
 * Rate limited: 10 uploads per 15 minutes per user
 *
 * Returns:
 * - If async processing available: { status: 'QUEUED', jobId, documentId }
 * - If sync fallback: { status: 'COMPLETED', documentId, statistics }
 */
router.post(
  '/upload',
  uploadRateLimiter,
  upload.single('file'),
  citationManagementController.upload.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/job/:jobId/status
 * Get job status for polling (used with async processing)
 *
 * Returns:
 * - status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
 * - progress: 0-100
 * - document: { documentId, statistics } (when completed)
 */
router.get(
  '/job/:jobId/status',
  validate(jobIdParamSchema),
  citationManagementController.getJobStatus.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/document/:documentId/analysis
 * Get complete citation analysis results
 */
router.get(
  '/document/:documentId/analysis',
  validate(documentIdParamSchema),
  citationManagementController.getAnalysis.bind(citationManagementController)
);

// ============================================
// REFERENCE MANAGEMENT
// ============================================

/**
 * POST /api/v1/citation-management/document/:documentId/reorder
 * Reorder references and auto-update in-text citations
 *
 * Body:
 * - referenceId: string (for single move)
 * - newPosition: number (for single move)
 * - sortBy: 'alphabetical' | 'year' | 'appearance' (for batch sort)
 */
router.post(
  '/document/:documentId/reorder',
  validate(reorderReferencesSchema),
  citationManagementController.reorderReferences.bind(citationManagementController)
);

/**
 * DELETE /api/v1/citation-management/document/:documentId/reference/:referenceId
 * Delete a reference and renumber remaining references
 * - Citations that pointed to the deleted reference become orphaned (shown in red)
 * - All remaining citations are renumbered automatically
 */
router.delete(
  '/document/:documentId/reference/:referenceId',
  validate(documentReferenceParamsSchema),
  citationManagementController.deleteReference.bind(citationManagementController)
);

/**
 * PATCH /api/v1/citation-management/document/:documentId/reference/:referenceId
 * Edit a reference (author, year, title, etc.)
 * - For author-year citations: Updates inline citations when author/year changes
 *
 * Body:
 * - authors?: string[] (list of author names)
 * - year?: string (publication year)
 * - title?: string
 * - journalName?: string
 * - volume?: string
 * - issue?: string
 * - pages?: string
 * - doi?: string
 * - url?: string
 * - publisher?: string
 */
router.patch(
  '/document/:documentId/reference/:referenceId',
  validate(editReferenceSchema),
  citationManagementController.editReference.bind(citationManagementController)
);

/**
 * POST /api/v1/citation-management/document/:documentId/resequence
 * Resequence references by first appearance order in text
 * - References are reordered to match citation appearance order
 * - All in-text citations are updated with new numbers
 * - Reference list is sorted to match new numbering
 */
router.post(
  '/document/:documentId/resequence',
  validate(documentIdParamSchema),
  citationManagementController.resequenceByAppearance.bind(citationManagementController)
);

// ============================================
// FORMAT CONVERSION
// ============================================

/**
 * POST /api/v1/citation-management/document/:documentId/convert-style
 * Convert citation style
 *
 * Body:
 * - targetStyle: 'APA' | 'MLA' | 'Chicago' | 'Vancouver' | 'IEEE' | 'Harvard' | 'AMA'
 */
router.post(
  '/document/:documentId/convert-style',
  validate(convertStyleSchema),
  citationManagementController.convertStyle.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/styles
 * Get list of supported citation styles
 */
router.get(
  '/styles',
  citationManagementController.getStyles.bind(citationManagementController)
);

// ============================================
// DOI VALIDATION
// ============================================

/**
 * POST /api/v1/citation-management/document/:documentId/validate-dois
 * Validate all DOIs in references
 *
 * Query:
 * - forceRefresh?: 'true' | 'false' - Force re-validation even if cached
 */
router.post(
  '/document/:documentId/validate-dois',
  validate(validateDoisSchema),
  citationManagementController.validateDOIs.bind(citationManagementController)
);

// ============================================
// PREVIEW & EXPORT
// ============================================

/**
 * GET /api/v1/citation-management/document/:documentId/preview
 * Preview changes that will be applied on export (JSON response for frontend)
 *
 * Query:
 * - changeType?: 'RENUMBER' | 'REFERENCE_STYLE_CONVERSION' | 'DELETE' | 'INSERT'
 * - includeReverted?: 'true' | 'false'
 */
router.get(
  '/document/:documentId/preview',
  validate(previewChangesSchema),
  citationManagementController.previewChanges.bind(citationManagementController)
);

/**
 * GET /api/v1/citation-management/document/:documentId/export
 * Export modified DOCX with preserved formatting
 * Rate limited: 30 exports per 15 minutes per user
 *
 * Query:
 * - acceptChanges: 'true' | 'false' - If true, apply changes cleanly without Track Changes
 */
router.get(
  '/document/:documentId/export',
  exportRateLimiter,
  validate(exportDocumentSchema),
  citationManagementController.exportDocument.bind(citationManagementController)
);

export default router;
