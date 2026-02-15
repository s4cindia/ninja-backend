/**
 * Citation Management Routes (V2 - Refactored)
 * Uses modular controllers for better maintainability
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.middleware';

// Import refactored controllers
import {
  citationUploadController,
  citationReferenceController,
  citationStyleController,
  citationExportController
} from '../controllers/citation';

// Rate limiter for file uploads
const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: { code: 'TOO_MANY_UPLOADS', message: 'Too many uploads. Please try again later.' }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userReq = req as Request & { user?: { id: string } };
    return userReq.user?.id || req.ip || 'unknown';
  }
});

const router = Router();

// Configure multer for DOCX uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

// Block debug endpoints in production
const blockInProduction = (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error: { code: 'DEBUG_DISABLED', message: 'Debug endpoints are disabled in production' }
    });
  }
  next();
};

// ============================================
// DEBUG ENDPOINTS (disabled in production)
// ============================================

router.get(
  '/document/:documentId/export-debug',
  blockInProduction,
  citationExportController.exportDebug.bind(citationExportController)
);

router.post(
  '/document/:documentId/debug-style-conversion',
  blockInProduction,
  citationExportController.debugStyleConversion.bind(citationExportController)
);

router.post(
  '/document/:documentId/reanalyze',
  blockInProduction,
  citationUploadController.reanalyze.bind(citationUploadController)
);

router.get(
  '/document/:documentId/preview-debug',
  blockInProduction,
  citationExportController.previewChanges.bind(citationExportController)
);

router.get(
  '/document/:documentId/export-debug-docx',
  blockInProduction,
  citationExportController.exportDocument.bind(citationExportController)
);

// ============================================
// DOCUMENT MANAGEMENT (citationUploadController)
// ============================================

router.post(
  '/upload',
  uploadRateLimiter,
  upload.single('file'),
  citationUploadController.upload.bind(citationUploadController)
);

router.get(
  '/document/:documentId/analysis',
  citationUploadController.getAnalysis.bind(citationUploadController)
);

// ============================================
// REFERENCE MANAGEMENT (citationReferenceController)
// ============================================

router.post(
  '/document/:documentId/reorder',
  citationReferenceController.reorderReferences.bind(citationReferenceController)
);

router.delete(
  '/document/:documentId/reference/:referenceId',
  citationReferenceController.deleteReference.bind(citationReferenceController)
);

router.patch(
  '/document/:documentId/reference/:referenceId',
  citationReferenceController.editReference.bind(citationReferenceController)
);

router.post(
  '/document/:documentId/resequence',
  citationReferenceController.resequenceByAppearance.bind(citationReferenceController)
);

// ============================================
// FORMAT CONVERSION (citationStyleController)
// ============================================

router.post(
  '/document/:documentId/convert-style',
  citationStyleController.convertStyle.bind(citationStyleController)
);

router.get(
  '/styles',
  citationStyleController.getStyles.bind(citationStyleController)
);

// ============================================
// DOI VALIDATION (citationStyleController)
// ============================================

router.post(
  '/document/:documentId/validate-dois',
  citationStyleController.validateDOIs.bind(citationStyleController)
);

// ============================================
// PREVIEW & EXPORT (citationExportController)
// ============================================

router.get(
  '/document/:documentId/preview',
  citationExportController.previewChanges.bind(citationExportController)
);

router.get(
  '/document/:documentId/export',
  citationExportController.exportDocument.bind(citationExportController)
);

export default router;
