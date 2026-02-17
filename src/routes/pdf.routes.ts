/**
 * PDF Routes
 *
 * REST API endpoints for PDF parsing, analysis, and accessibility auditing.
 */

import { Router, Request } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { pdfController } from '../controllers/pdf.controller';
import { pdfAcrController } from '../controllers/pdf-acr.controller';
import { fileStorageService } from '../services/storage/file-storage.service';

const router = Router();

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
  fileFilter: (_req, file, cb) => {
    // Accept PDF files based on MIME type or filename
    const validMimetypes = [
      'application/pdf',
      'application/x-pdf',
      'application/octet-stream', // Browsers often use this
    ];

    const isPdfMimetype = validMimetypes.includes(file.mimetype);
    const isPdfFilename = file.originalname.toLowerCase().endsWith('.pdf');

    if (isPdfMimetype || isPdfFilename) {
      // Additional validation will be done in controller (magic bytes check)
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// Rate limiting for uploads (10 uploads per minute per user)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per window
  message: 'Too many upload requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req: Request) => {
    // Use user ID if authenticated, otherwise IP
    return req.user?.id || req.ip || 'unknown';
  },
});

// ============================================================================
// AUDIT ENDPOINTS (US-PDF-4.1)
// ============================================================================

/**
 * POST /pdf/audit-upload
 * Upload and audit a PDF file
 *
 * Accepts multipart/form-data with PDF file
 * Creates job record and runs audit
 *
 * @body file - PDF file (multipart/form-data)
 * @returns { jobId, fileName, auditReport }
 */
router.post(
  '/audit-upload',
  authenticate,
  uploadLimiter,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { message: 'No file uploaded' },
        });
      }

      // Validate PDF magic bytes (PDF files start with %PDF-)
      const buffer = req.file.buffer;
      const magicBytes = buffer.slice(0, 5).toString('ascii');

      if (!magicBytes.startsWith('%PDF-')) {
        return res.status(400).json({
          success: false,
          error: { message: 'Invalid PDF file: file does not contain PDF magic bytes' },
        });
      }

      return await pdfController.auditFromBuffer(req as any, res);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /pdf/audit-file
 * Audit a PDF file from an existing file ID
 *
 * Used for two-step upload flow:
 * 1. Upload file to S3 (via presigned URL or /files/upload)
 * 2. Call this endpoint with fileId to start audit
 *
 * @body fileId - File ID from previous upload
 * @returns { jobId, status, message }
 */
router.post('/audit-file', authenticate, async (req, res, next) => {
  try {
    return await pdfController.auditFromFileId(req as any, res);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /pdf/job/:jobId/re-scan
 * Re-run audit with different scan level
 *
 * @param jobId - Job ID
 * @body scanLevel - 'basic' | 'comprehensive' | 'custom'
 * @body customValidators - Optional array of validators (for custom scan)
 * @returns { success: true, jobId, scanLevel }
 */
router.post(
  '/job/:jobId/re-scan',
  authenticate,
  authorizeJob,
  async (req, res, next) => {
    try {
      return await pdfController.reScanJob(req as any, res);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /pdf/job/:jobId/file
 * Get the PDF file for preview
 *
 * @param jobId - Job ID
 * @returns PDF file stream
 */
router.get(
  '/job/:jobId/file',
  authenticate,
  authorizeJob,
  async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const job = (req as { job: { id: string; input: { fileName?: string } } }).job;

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      const fileName = (job.input as { fileName?: string })?.fileName || 'document.pdf';
      const filePath = await fileStorageService.getFilePath(jobId, fileName);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      res.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /pdf/job/:jobId/status
 * Get audit job status
 *
 * @param jobId - Job ID
 * @returns { jobId, status, progress, createdAt, updatedAt }
 */
router.get(
  '/job/:jobId/status',
  authenticate,
  authorizeJob,
  async (req, res, next) => {
    try{
      // TODO: Implement job status retrieval
      res.status(501).json({
        success: false,
        error: {
          message: 'Job status endpoint not yet implemented',
          code: 'NOT_IMPLEMENTED',
        },
      });

      // Future implementation:
      // const status = await pdfAuditController.getJobStatus(req.params.jobId);
      // res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /pdf/job/:jobId/audit/result
 * Get full audit results
 *
 * @param jobId - Job ID
 * @returns PdfAuditResult or 202 if still processing
 */
router.get(
  '/job/:jobId/audit/result',
  authenticate,
  authorizeJob,
  (req, res) => pdfController.getAuditResult(req, res)
);

/**
 * GET /pdf/job/:jobId/acr
 * Generate and return ACR report
 *
 * @param jobId - Job ID
 * @query productName   - Override product name (defaults to file name)
 * @query productVersion - Override product version (defaults to '1.0')
 * @query vendor        - Override vendor name
 * @query evaluator     - Override evaluator name
 * @returns ACRReport
 */
router.get(
  '/job/:jobId/acr',
  authenticate,
  authorizeJob,
  (req, res) => pdfAcrController.generateAcr(req, res)
);

/**
 * GET /pdf/job/:jobId/acr/criteria
 * Return only the WCAG criterion results (lighter payload for verification queue)
 *
 * @param jobId - Job ID
 * @returns WcagCriterionResult[]
 */
router.get(
  '/job/:jobId/acr/criteria',
  authenticate,
  authorizeJob,
  (req, res) => pdfAcrController.getAcrCriteria(req, res)
);

/**
 * GET /pdf/job/:jobId/report
 * Download audit report as PDF or DOCX
 *
 * @param jobId - Job ID
 * @query format - Report format (pdf|docx)
 * @returns File download
 */
router.get(
  '/job/:jobId/report',
  authenticate,
  authorizeJob,
  async (req, res, next) => {
    try {
      const format = (req.query.format as string) || 'pdf';

      if (!['pdf', 'docx'].includes(format)) {
        return res.status(400).json({
          success: false,
          error: { message: 'Invalid format. Must be pdf or docx' },
        });
      }

      // TODO: Implement report generation and download
      res.status(501).json({
        success: false,
        error: {
          message: 'Report download endpoint not yet implemented',
          code: 'NOT_IMPLEMENTED',
        },
      });

      // Future implementation:
      // const report = await pdfAuditController.generateReport(req.params.jobId, format);
      // res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      // res.setHeader('Content-Disposition', `attachment; filename="audit-report-${req.params.jobId}.${format}"`);
      // res.send(report);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /pdf/audits
 * List user's PDF audits (paginated)
 *
 * @query page - Page number (default: 1)
 * @query limit - Items per page (default: 20, max: 100)
 * @query status - Filter by status (queued|processing|completed|failed)
 * @returns { data: PdfAuditResult[], pagination }
 */
router.get(
  '/audits',
  authenticate,
  async (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for future pagination implementation
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const status = req.query.status as string;

      if (page < 1) {
        return res.status(400).json({
          success: false,
          error: { message: 'Page must be >= 1' },
        });
      }

      if (status && !['queued', 'processing', 'completed', 'failed'].includes(status)) {
        return res.status(400).json({
          success: false,
          error: { message: 'Invalid status filter' },
        });
      }

      // TODO: Implement audit listing
      res.status(501).json({
        success: false,
        error: {
          message: 'Audit listing endpoint not yet implemented',
          code: 'NOT_IMPLEMENTED',
        },
      });

      // Future implementation:
      // const userId = (req as any).user.id;
      // const result = await pdfAuditController.listAudits(userId, { page, limit, status });
      // res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /pdf/job/:jobId
 * Soft delete audit record
 *
 * @param jobId - Job ID
 * @returns { success: true }
 */
router.delete(
  '/job/:jobId',
  authenticate,
  authorizeJob,
  async (req, res, next) => {
    try {
      // TODO: Implement soft delete
      res.status(501).json({
        success: false,
        error: {
          message: 'Delete endpoint not yet implemented',
          code: 'NOT_IMPLEMENTED',
        },
      });

      // Future implementation:
      // await pdfAuditController.deleteJob(req.params.jobId);
      // res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// ANALYSIS ENDPOINTS (Existing functionality)
// ============================================================================

/**
 * POST /pdf/parse
 * Parse PDF and return metadata
 */
router.post('/parse', authenticate, (req, res, next) => pdfController.parse(req, res, next));

/**
 * POST /pdf/metadata
 * Get PDF metadata
 */
router.post('/metadata', authenticate, (req, res, next) => pdfController.getMetadata(req, res, next));

/**
 * POST /pdf/validate-basics
 * Basic validation checks (tagged, language, title)
 */
router.post('/validate-basics', authenticate, (req, res, next) => pdfController.validateBasics(req, res, next));

/**
 * POST /pdf/extract-text
 * Extract text from PDF
 */
router.post('/extract-text', authenticate, (req, res, next) => pdfController.extractText(req, res, next));

/**
 * POST /pdf/extract-page/:pageNumber
 * Extract text from specific page
 */
router.post('/extract-page/:pageNumber', authenticate, (req, res, next) => pdfController.extractPage(req, res, next));

/**
 * POST /pdf/text-stats
 * Get text statistics
 */
router.post('/text-stats', authenticate, (req, res, next) => pdfController.getTextStats(req, res, next));

/**
 * POST /pdf/extract-images
 * Extract images from PDF
 */
router.post('/extract-images', authenticate, (req, res, next) => pdfController.extractImages(req, res, next));

/**
 * POST /pdf/image/:imageId
 * Get specific image by ID
 */
router.post('/image/:imageId', authenticate, (req, res, next) => pdfController.getImageById(req, res, next));

/**
 * POST /pdf/image-stats
 * Get image statistics
 */
router.post('/image-stats', authenticate, (req, res, next) => pdfController.getImageStats(req, res, next));

/**
 * POST /pdf/analyze-structure
 * Analyze PDF structure (headings, tables, lists, etc.)
 */
router.post('/analyze-structure', authenticate, (req, res, next) => pdfController.analyzeStructure(req, res, next));

/**
 * POST /pdf/analyze-headings
 * Analyze heading hierarchy
 */
router.post('/analyze-headings', authenticate, (req, res, next) => pdfController.analyzeHeadings(req, res, next));

/**
 * POST /pdf/analyze-tables
 * Analyze tables
 */
router.post('/analyze-tables', authenticate, (req, res, next) => pdfController.analyzeTables(req, res, next));

/**
 * POST /pdf/analyze-links
 * Analyze links
 */
router.post('/analyze-links', authenticate, (req, res, next) => pdfController.analyzeLinks(req, res, next));

export default router;
