/**
 * Citation Intelligence Tool Routes
 */

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { citationController } from '../controllers/citation.controller';

const router = Router();

// Configure multer for file uploads (memory storage for processing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
      'application/pdf', // PDF (optional)
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only DOCX and PDF files are allowed'));
    }
  },
});

// All routes require authentication
router.use(authenticate);

// Get recent citation jobs
router.get(
  '/jobs/recent',
  citationController.getRecentJobs.bind(citationController)
);

// Editorial Services citation detection (stub - not yet implemented)
router.post('/detect', (req, res) => {
  // This endpoint is for Editorial Services in-document citation detection
  // Currently returning empty result to prevent 404 errors
  res.json({
    success: true,
    data: {
      citations: [],
      totalCount: 0,
      byType: {},
      byStyle: {},
    },
  });
});

router.post('/detect/:jobId', (req, res) => {
  res.json({
    success: true,
    data: {
      citations: [],
      totalCount: 0,
      byType: {},
      byStyle: {},
    },
  });
});

// Upload and analyze manuscript
router.post(
  '/upload',
  upload.single('file'),
  citationController.upload.bind(citationController)
);

// Get job processing progress
router.get(
  '/job/:jobId/progress',
  citationController.getProgress.bind(citationController)
);

// Get analysis results (the dashboard)
router.get(
  '/job/:jobId/analysis',
  citationController.getAnalysis.bind(citationController)
);

// Get reference list with verification status
router.get(
  '/job/:jobId/references',
  citationController.getReferences.bind(citationController)
);

// Verify DOI for a specific reference
router.post(
  '/reference/:refId/verify-doi',
  citationController.verifyDOI.bind(citationController)
);

// Get ghost citations and issues
router.get(
  '/job/:jobId/issues',
  citationController.getIssues.bind(citationController)
);

// Convert references to a specific citation style
router.post(
  '/job/:jobId/convert-style',
  citationController.convertStyle.bind(citationController)
);

// Export corrected manuscript as DOCX
router.get(
  '/job/:jobId/export-corrected',
  citationController.exportCorrectedDOCX.bind(citationController)
);

// Export change summary report as DOCX
router.get(
  '/job/:jobId/export-summary',
  citationController.exportChangeSummary.bind(citationController)
);

// Get manuscript content with citation positions for editor
router.get(
  '/job/:jobId/manuscript',
  citationController.getManuscript.bind(citationController)
);

// Export manuscript with corrected references (new implementation)
router.post(
  '/job/:jobId/export',
  citationController.exportWithCorrections.bind(citationController)
);

export default router;
