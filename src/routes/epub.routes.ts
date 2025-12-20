import { Router } from 'express';
import multer from 'multer';
import { epubController } from '../controllers/epub.controller';
import { authenticate } from '../middleware/auth.middleware';

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

router.post('/audit/:jobId', authenticate, epubController.auditEPUB);
router.post('/audit-upload', authenticate, upload.single('file'), epubController.auditFromBuffer);
router.get('/audit/:jobId/result', authenticate, epubController.getAuditResult);

router.post('/job/:jobId/remediation', authenticate, epubController.createRemediationPlan);
router.get('/job/:jobId/remediation', authenticate, epubController.getRemediationPlan);
router.get('/job/:jobId/remediation/summary', authenticate, epubController.getRemediationSummary);
router.patch('/job/:jobId/remediation/task/:taskId', authenticate, epubController.updateTaskStatus);
router.post('/job/:jobId/auto-remediate', authenticate, epubController.runAutoRemediation);
router.post('/job/:jobId/apply-fix', authenticate, epubController.applySpecificFix);
router.get('/job/:jobId/download-remediated', authenticate, epubController.downloadRemediatedFile);
router.get('/supported-fixes', authenticate, epubController.getSupportedFixes);

export default router;
