/**
 * PDF AI Analysis Routes
 *
 * Endpoints for triggering AI issue analysis, retrieving suggestions,
 * and applying fixes to PDF files.
 *
 * All routes require authentication + job ownership authorization.
 * Base path (registered in index.ts): /pdf
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob } from '../middleware/authorize-job.middleware';
import { pdfAiAnalysisController } from '../controllers/pdf-ai-analysis.controller';

const router = Router();

/**
 * POST /pdf/:jobId/auto-tag
 * Retry Adobe AutoTag (fire-and-forget, returns 202).
 */
router.post(
  '/:jobId/auto-tag',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.retryAutoTag.bind(pdfAiAnalysisController)
);

/**
 * GET /pdf/:jobId/auto-tag/status
 * Returns auto-tag status from job.output.
 */
router.get(
  '/:jobId/auto-tag/status',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.getAutoTagStatus.bind(pdfAiAnalysisController)
);

/**
 * GET /pdf/:jobId/auto-tag/report
 * Stream the Adobe tagging report XML.
 */
router.get(
  '/:jobId/auto-tag/report',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.getTaggingReport.bind(pdfAiAnalysisController)
);

/**
 * GET /pdf/:jobId/auto-tag/word
 * Download the Word (.docx) export.
 */
router.get(
  '/:jobId/auto-tag/word',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.downloadWord.bind(pdfAiAnalysisController)
);

/**
 * POST /pdf/:jobId/ai-analysis
 * Trigger AI analysis for all issues in a completed audit job (async, returns 202).
 * Body: { overrides?: Partial<AiRemediationConfig> }
 */
router.post(
  '/:jobId/ai-analysis',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.triggerAnalysis.bind(pdfAiAnalysisController)
);

/**
 * GET /pdf/:jobId/ai-analysis
 * Retrieve all AI suggestions for a job.
 */
router.get(
  '/:jobId/ai-analysis',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.getAnalysis.bind(pdfAiAnalysisController)
);

/**
 * POST /pdf/:jobId/ai-analysis/apply-all
 * Apply all approved apply-to-pdf suggestions in a single PDF pass.
 * Must be declared BEFORE /:issueId routes to avoid ambiguity.
 */
router.post(
  '/:jobId/ai-analysis/apply-all',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.applyAll.bind(pdfAiAnalysisController)
);

/**
 * PATCH /pdf/:jobId/ai-analysis/:issueId
 * Update suggestion status (approved | rejected).
 */
router.patch(
  '/:jobId/ai-analysis/:issueId',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.updateStatus.bind(pdfAiAnalysisController)
);

/**
 * POST /pdf/:jobId/ai-analysis/:issueId/apply
 * Apply a single approved suggestion to the PDF.
 */
router.post(
  '/:jobId/ai-analysis/:issueId/apply',
  authenticate,
  authorizeJob,
  pdfAiAnalysisController.applySuggestion.bind(pdfAiAnalysisController)
);

export default router;
