import { Router } from 'express';
import multer from 'multer';
import { epubController } from '../controllers/epub.controller';
import { epubContentController } from '../controllers/epub-content.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Accept epub+zip mimetype OR octet-stream (browsers often use this) OR filename ending in .epub
    const validMimetypes = ['application/epub+zip', 'application/octet-stream'];
    if (validMimetypes.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.epub')) {
      cb(null, true);
    } else {
      cb(new Error('Only EPUB files are allowed'));
    }
  },
});

router.post('/audit/:jobId', authenticate, authorizeJob, epubController.auditEPUB);
router.post('/audit-upload', authenticate, upload.single('file'), epubController.auditFromBuffer);
router.post('/audit-file', authenticate, epubController.auditFromFileId);
router.get('/audit/:jobId/result', authenticate, authorizeJob, epubController.getAuditResult);
router.get('/job/:jobId/audit/result', authenticate, authorizeJob, epubController.getAuditResult);
router.get('/job/:jobId', authenticate, authorizeJob, epubController.getJob);

router.post('/job/:jobId/remediation', authenticate, authorizeJob, epubController.createRemediationPlan);
router.get('/job/:jobId/remediation', authenticate, authorizeJob, epubController.getRemediationPlan);
router.get('/job/:jobId/remediation/summary', authenticate, authorizeJob, epubController.getRemediationSummary);
router.get('/job/:jobId/remediation/similar-issues', authenticate, authorizeJob, epubController.getSimilarIssuesGrouping);
router.post('/job/:jobId/remediation/start', authenticate, authorizeJob, epubController.startRemediation);
router.post('/job/:jobId/remediation/quick-fix/batch', authenticate, authorizeJob, epubController.applyBatchQuickFix);
router.patch('/job/:jobId/remediation/task/:taskId', authenticate, authorizeJob, epubController.updateTaskStatus);
router.patch('/job/:jobId/remediation/task/:taskId/fix', authenticate, authorizeJob, epubController.markManualTaskFixed);
router.post('/job/:jobId/reaudit', authenticate, authorizeJob, upload.single('file'), epubController.reauditEpub);
router.post('/job/:jobId/transfer-to-acr', authenticate, authorizeJob, epubController.transferToAcr);
router.get('/acr/:acrWorkflowId', authenticate, epubController.getAcrWorkflow);
router.patch('/acr/:acrWorkflowId/criteria/:criteriaId', authenticate, epubController.updateAcrCriteria);
router.post('/job/:jobId/auto-remediate', authenticate, authorizeJob, epubController.runAutoRemediation);
router.post('/job/:jobId/apply-fix', authenticate, authorizeJob, epubController.applySpecificFix);
router.post('/job/:jobId/apply-quick-fix', authenticate, authorizeJob, epubController.applyQuickFix);
router.post('/job/:jobId/apply-batch-quick-fix', authenticate, authorizeJob, epubController.applyBatchQuickFix);
router.post('/:jobId/apply-fix', authenticate, authorizeJob, epubController.applyQuickFix);
router.get('/job/:jobId/download-remediated', authenticate, authorizeJob, epubController.downloadRemediatedFile);
router.get('/job/:jobId/comparison', authenticate, authorizeJob, epubController.getComparison);
router.get('/job/:jobId/comparison/summary', authenticate, authorizeJob, epubController.getComparisonSummary);
router.get('/supported-fixes', authenticate, epubController.getSupportedFixes);

router.post('/batch', authenticate, epubController.createBatch);
router.post('/batch/:batchId/start', authenticate, epubController.startBatch);
router.get('/batch/:batchId', authenticate, epubController.getBatchStatus);
router.post('/batch/:batchId/cancel', authenticate, epubController.cancelBatch);
router.post('/batch/:batchId/retry/:jobId', authenticate, epubController.retryBatchJob);
router.get('/batches', authenticate, epubController.listBatches);

router.get('/job/:jobId/export', authenticate, authorizeJob, epubController.exportRemediated);
router.post('/export-batch', authenticate, epubController.exportBatch);
router.get('/job/:jobId/report', authenticate, authorizeJob, epubController.getAccessibilityReport);
router.get('/job/:jobId/content', authenticate, authorizeJob, epubContentController.getContent);
router.get('/job/:jobId/scan-epub-types', authenticate, authorizeJob, epubController.scanEpubTypes);
router.post('/job/:jobId/task/:taskId/mark-fixed', authenticate, authorizeJob, epubController.markTaskFixed);
router.post('/job/:jobId/generate-alt-text', authenticate, authorizeJob, epubController.generateImageAltText);
router.get('/job/:jobId/asset/*', authenticate, authorizeJob, epubController.getAsset);
router.get('/job/:jobId/image/*', authenticate, authorizeJob, epubController.getImage);

router.get('/fix-template/:issueCode', authenticate, epubController.getFixTemplate);
router.get('/fix-templates', authenticate, epubController.getAllFixTemplates);

// Dev endpoints (no auth) - for testing fix templates
// Only enabled when explicitly opted in via ENABLE_DEV_ROUTES=true
if (process.env.ENABLE_DEV_ROUTES === 'true') {
  router.get('/dev/fix-template/:issueCode', epubController.getFixTemplate);
  router.get('/dev/fix-templates', epubController.getAllFixTemplates);
}

export default router;
