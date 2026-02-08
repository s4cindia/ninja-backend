import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { authorizeJob, authorizeAcr } from '../middleware/authorize-job.middleware';
import { validate } from '../middleware/validate.middleware';
import { acrController } from '../controllers/acr.controller';
import { verificationController } from '../controllers/verification.controller';
import { acrReportReviewController } from '../controllers/acr-report-review.controller';
import { batchAcrGenerateSchema, batchAcrExportSchema } from '../schemas/acr.schemas';

const router = Router();

const epubFileFilter = (req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = ['application/epub+zip', 'application/octet-stream'];
  const allowedExtensions = ['.epub'];
  const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
  
  if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only EPUB files are allowed'));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: epubFileFilter,
});

router.use(authenticate);

router.post('/analysis-with-upload', upload.single('file'), acrController.createAnalysisWithUpload.bind(acrController));
router.get('/analysis/:jobId', acrController.getAnalysis.bind(acrController));
router.post('/generate', acrController.generateAcr.bind(acrController));
router.post('/generate-remarks', acrController.generateRemarks.bind(acrController));
router.get('/editions', acrController.getAllEditions.bind(acrController));
router.get('/editions/:editionCode/criteria', acrController.getEditionCriteria.bind(acrController));
router.get('/criteria/:criterionId', acrController.getCriterion.bind(acrController));
router.get('/editions/:edition', acrController.getEditionInfo.bind(acrController));
router.get('/remarks-requirements', acrController.getRemarksRequirements.bind(acrController));
router.get('/criterion-guidance', acrController.getCriterionGuidance.bind(acrController));
router.post('/:jobId/validate-credibility', authorizeJob, acrController.validateCredibility.bind(acrController));
router.get('/:jobId/can-finalize', authorizeJob, verificationController.canFinalize.bind(verificationController));
router.post('/:jobId/finalize', authorizeJob, acrController.finalizeAcr.bind(acrController));
router.get('/:jobId/methodology', authorizeJob, acrController.getMethodology.bind(acrController));
router.post('/:acrId/export', authorizeAcr, acrController.exportAcr.bind(acrController));

router.get('/:acrId/versions', authorizeAcr, acrController.getVersions.bind(acrController));
router.post('/:acrId/versions', authorizeAcr, acrController.createVersion.bind(acrController));
router.get('/:acrId/versions/:version', authorizeAcr, acrController.getVersion.bind(acrController));
router.get('/:acrId/compare', authorizeAcr, acrController.compareVersions.bind(acrController));

router.post('/analysis', acrController.createAnalysis.bind(acrController));
router.get('/job/:jobId/analysis', acrController.getAcrAnalysisByJobId.bind(acrController));
router.get('/job/:jobId', acrController.getAcrJobByJobId.bind(acrController));
router.get('/:acrJobId', acrController.getAcrAnalysis.bind(acrController));
router.get('/:acrJobId/analysis', acrController.getAcrAnalysis.bind(acrController));
router.post('/:acrJobId/criteria/:criterionId/review', acrController.saveCriterionReview.bind(acrController));
router.patch('/:acrJobId/criteria/:criterionId', acrController.saveCriterionReview.bind(acrController));
router.get('/:acrJobId/criteria/:criterionId', acrController.getCriterionDetailsFromJob.bind(acrController));
router.post('/:acrJobId/reviews/bulk', acrController.saveBulkReviews.bind(acrController));

// ===== Review & Edit API (Phase 1) =====
// Initialize report from verification data (import step)
router.post('/report/:jobId/initialize', acrReportReviewController.initializeReport.bind(acrReportReviewController));

// Get complete report for Review & Edit page (pre-populated from verification)
router.get('/report/:jobId', acrReportReviewController.getReport.bind(acrReportReviewController));

// Delete ALL versions of report (use for cleanup only - versioning preserves history)
router.delete('/report/:jobId', acrReportReviewController.deleteReport.bind(acrReportReviewController));

// List all draft versions for a job
router.get('/report/:jobId/versions', acrReportReviewController.listVersions.bind(acrReportReviewController));

// Get specific report version by acrJobId
router.get('/report/version/:acrJobId', acrReportReviewController.getReportVersion.bind(acrReportReviewController));

// Update single criterion (minimal editing)
router.patch('/report/:acrJobId/criteria/:criterionId', acrReportReviewController.updateCriterion.bind(acrReportReviewController));

// Update report metadata (executive summary, etc.)
router.patch('/report/:acrJobId/metadata', acrReportReviewController.updateMetadata.bind(acrReportReviewController));

// Get criterion change history
router.get('/report/:acrJobId/criteria/:criterionId/history', acrReportReviewController.getCriterionHistory.bind(acrReportReviewController));

// Approve report for export
router.post('/report/:acrJobId/approve', acrReportReviewController.approveReport.bind(acrReportReviewController));

router.post(
  '/batch/generate',
  authorize('ADMIN', 'USER'),
  validate({ body: batchAcrGenerateSchema }),
  acrController.generateBatchAcr.bind(acrController)
);

router.get(
  '/batch/:batchAcrId',
  acrController.getBatchAcr.bind(acrController)
);

router.post(
  '/batch/:batchAcrId/export',
  validate({ body: batchAcrExportSchema }),
  acrController.exportBatchAcr.bind(acrController)
);

router.get(
  '/batch/:batchId/history',
  acrController.getBatchAcrHistory.bind(acrController)
);

export default router;
