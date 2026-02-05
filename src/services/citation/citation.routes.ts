/**
 * Citation Routes
 * API route definitions for citation detection and parsing
 */

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { citationController } from './citation.controller';
import { citationValidationController } from '../../controllers/citation-validation.controller';
import { citationCorrectionController } from '../../controllers/citation-correction.controller';
import { referenceListController } from '../../controllers/reference-list.controller';
import {
  documentIdParamSchema,
  citationIdParamSchema,
  jobIdParamSchema,
} from './citation.schemas';

const router = Router();

// File upload configuration for citation detection
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (_req, file, cb) => {
    const allowedExt = ['pdf', 'docx', 'txt', 'epub'];
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (allowedExt.includes(ext || '')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Allowed: PDF, DOCX, TXT, EPUB'));
    }
  },
});

// Apply authentication to all routes
router.use(authenticate);

// ============================================
// STATIC ROUTES (must come before parameterized)
// ============================================

// Upload and detect
router.post(
  '/detect',
  upload.single('file'),
  citationController.detectFromUpload.bind(citationController)
);

// ============================================
// DOCUMENT-LEVEL ROUTES
// ============================================

router.get(
  '/document/:documentId',
  validate({ params: documentIdParamSchema }),
  citationController.getCitations.bind(citationController)
);

router.post(
  '/document/:documentId/redetect',
  validate({ params: documentIdParamSchema }),
  citationController.redetect.bind(citationController)
);

router.post(
  '/document/:documentId/parse-all',
  validate({ params: documentIdParamSchema }),
  citationController.parseAllCitations.bind(citationController)
);

router.get(
  '/document/:documentId/with-components',
  validate({ params: documentIdParamSchema }),
  citationController.getCitationsWithComponents.bind(citationController)
);

router.get(
  '/document/:documentId/stats',
  validate({ params: documentIdParamSchema }),
  citationController.getStats.bind(citationController)
);

// ============================================
// JOB-LEVEL ROUTES
// ============================================

router.get(
  '/job/:jobId',
  validate({ params: jobIdParamSchema }),
  citationController.getCitationsByJob.bind(citationController)
);

// ============================================
// CITATION-LEVEL ROUTES (parameterized - last)
// ============================================

router.get(
  '/:citationId',
  validate({ params: citationIdParamSchema }),
  citationController.getCitation.bind(citationController)
);

router.get(
  '/:citationId/components',
  validate({ params: citationIdParamSchema }),
  citationController.getComponents.bind(citationController)
);

router.post(
  '/:citationId/parse',
  validate({ params: citationIdParamSchema }),
  citationController.parseCitation.bind(citationController)
);

router.post(
  '/:citationId/reparse',
  validate({ params: citationIdParamSchema }),
  citationController.reparseCitation.bind(citationController)
);

// ============================================
// VALIDATION ROUTES
// ============================================

router.get(
  '/styles',
  citationValidationController.getStyles.bind(citationValidationController)
);

router.post(
  '/document/:documentId/validate',
  validate({ params: documentIdParamSchema }),
  citationValidationController.validateDocument.bind(citationValidationController)
);

router.get(
  '/document/:documentId/validations',
  validate({ params: documentIdParamSchema }),
  citationValidationController.getValidations.bind(citationValidationController)
);

// ============================================
// CORRECTION ROUTES
// ============================================

router.post(
  '/validation/:validationId/accept',
  citationCorrectionController.acceptCorrection.bind(citationCorrectionController)
);

router.post(
  '/validation/:validationId/reject',
  citationCorrectionController.rejectCorrection.bind(citationCorrectionController)
);

router.post(
  '/validation/:validationId/edit',
  citationCorrectionController.applyManualEdit.bind(citationCorrectionController)
);

router.post(
  '/document/:documentId/correct/batch',
  validate({ params: documentIdParamSchema }),
  citationCorrectionController.batchCorrect.bind(citationCorrectionController)
);

router.get(
  '/document/:documentId/changes',
  validate({ params: documentIdParamSchema }),
  citationCorrectionController.getChanges.bind(citationCorrectionController)
);

router.post(
  '/change/:changeId/revert',
  citationCorrectionController.revertChange.bind(citationCorrectionController)
);

// ============================================
// REFERENCE LIST ROUTES
// ============================================

router.post(
  '/document/:documentId/reference-list/generate',
  validate({ params: documentIdParamSchema }),
  referenceListController.generateReferenceList.bind(referenceListController)
);

router.patch(
  '/reference-list/:entryId',
  referenceListController.updateEntry.bind(referenceListController)
);

router.post(
  '/document/:documentId/reference-list/finalize',
  validate({ params: documentIdParamSchema }),
  referenceListController.finalizeReferenceList.bind(referenceListController)
);

export default router;
