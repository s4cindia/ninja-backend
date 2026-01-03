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
    if (file.mimetype === 'application/epub+zip' || file.originalname.endsWith('.epub')) {
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

router.post('/job/:jobId/remediation', authenticate, authorizeJob, epubController.createRemediationPlan);
router.get('/job/:jobId/remediation', authenticate, authorizeJob, epubController.getRemediationPlan);
router.get('/job/:jobId/remediation/summary', authenticate, authorizeJob, epubController.getRemediationSummary);
router.patch('/job/:jobId/remediation/task/:taskId', authenticate, authorizeJob, epubController.updateTaskStatus);
router.patch('/job/:jobId/remediation/task/:taskId/fix', authenticate, authorizeJob, epubController.markManualTaskFixed);
router.post('/job/:jobId/reaudit', authenticate, authorizeJob, upload.single('file'), epubController.reauditEpub);
router.post('/job/:jobId/transfer-to-acr', authenticate, authorizeJob, epubController.transferToAcr);
router.get('/acr/:acrWorkflowId', authenticate, epubController.getAcrWorkflow);
router.patch('/acr/:acrWorkflowId/criteria/:criteriaId', authenticate, epubController.updateAcrCriteria);
router.post('/job/:jobId/auto-remediate', authenticate, authorizeJob, epubController.runAutoRemediation);
router.post('/job/:jobId/apply-fix', authenticate, authorizeJob, epubController.applySpecificFix);
router.post('/job/:jobId/apply-quick-fix', authenticate, authorizeJob, epubController.applyQuickFix);
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

export default router;
