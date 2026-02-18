import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { pdfAcrGeneratorService, ProductInfo } from '../services/pdf/acr-generator.service';
import type { AuditReport } from '../services/audit/base-audit.service';

class PdfAcrController {
  /**
   * GET /pdf/job/:jobId/acr
   *
   * Generate and return an ACR report for a completed PDF audit job.
   * Accepts optional query params to override product metadata.
   *
   * Query params:
   *   format        - 'json' (default) | 'html' (reserved for future)
   *   productName   - Product name (defaults to file name)
   *   productVersion - Product version (defaults to '1.0')
   *   vendor        - Vendor name (defaults to 'Unknown')
   *   evaluator     - Evaluator name (defaults to authenticated user email)
   */
  async generateAcr(req: Request, res: Response): Promise<void> {
    const job = req.job;

    if (!job) {
      res.status(404).json({
        success: false,
        error: { message: 'Job not found or access denied', code: 'JOB_NOT_FOUND' },
      });
      return;
    }

    if (job.status !== 'COMPLETED') {
      res.status(409).json({
        success: false,
        error: {
          message: `Job is not completed yet (status: ${job.status})`,
          code: 'JOB_NOT_COMPLETED',
        },
      });
      return;
    }

    const output = job.output as Record<string, unknown> | null;
    const auditReport = output?.auditReport as AuditReport | undefined;

    if (!auditReport) {
      res.status(404).json({
        success: false,
        error: {
          message: 'Audit report not found for this job',
          code: 'AUDIT_REPORT_NOT_FOUND',
        },
      });
      return;
    }

    const input = job.input as Record<string, unknown> | null;
    const fileName = (input?.fileName as string) || (auditReport.fileName as string) || 'document.pdf';

    const productInfo: ProductInfo = {
      name: (req.query.productName as string) || fileName,
      version: (req.query.productVersion as string) || '1.0',
      vendor: (req.query.vendor as string) || 'Unknown',
      evaluationDate: new Date(job.createdAt).toISOString().split('T')[0],
      evaluator: (req.query.evaluator as string) || req.user?.email || 'Unknown',
    };

    try {
      const acrReport = await pdfAcrGeneratorService.generateAcr(auditReport, productInfo);

      logger.info(`[PdfAcrController] ACR generated for job ${job.id}: ${acrReport.wcagResults.length} criteria`);

      res.json({ success: true, data: acrReport });
    } catch (error) {
      logger.error(`[PdfAcrController] Failed to generate ACR for job ${job.id}:`, error);
      res.status(500).json({
        success: false,
        error: { message: 'Failed to generate ACR report', code: 'ACR_GENERATION_FAILED' },
      });
    }
  }

  /**
   * GET /pdf/job/:jobId/acr/criteria
   *
   * Return only the WCAG criterion results for a completed PDF audit job.
   * Lighter payload than the full ACR — useful for populating the
   * verification queue without loading the entire report.
   */
  async getAcrCriteria(req: Request, res: Response): Promise<void> {
    const job = req.job;

    if (!job) {
      res.status(404).json({
        success: false,
        error: { message: 'Job not found or access denied', code: 'JOB_NOT_FOUND' },
      });
      return;
    }

    if (job.status !== 'COMPLETED') {
      res.status(409).json({
        success: false,
        error: {
          message: `Job is not completed yet (status: ${job.status})`,
          code: 'JOB_NOT_COMPLETED',
        },
      });
      return;
    }

    const output = job.output as Record<string, unknown> | null;
    const auditReport = output?.auditReport as AuditReport | undefined;

    if (!auditReport) {
      res.status(404).json({
        success: false,
        error: { message: 'Audit report not found for this job', code: 'AUDIT_REPORT_NOT_FOUND' },
      });
      return;
    }

    const input = job.input as Record<string, unknown> | null;
    const fileName = (input?.fileName as string) || (auditReport.fileName as string) || 'document.pdf';

    const productInfo: ProductInfo = {
      name: fileName,
      version: '1.0',
      vendor: 'Unknown',
      evaluationDate: new Date(job.createdAt).toISOString().split('T')[0],
      evaluator: req.user?.email || 'Unknown',
    };

    try {
      const acrReport = await pdfAcrGeneratorService.generateAcr(auditReport, productInfo);

      res.json({ success: true, data: acrReport.wcagResults });
    } catch (error) {
      logger.error(`[PdfAcrController] Failed to get ACR criteria for job ${job.id}:`, error);
      res.status(500).json({
        success: false,
        error: { message: 'Failed to generate ACR criteria', code: 'ACR_GENERATION_FAILED' },
      });
    }
  }
}

export const pdfAcrController = new PdfAcrController();
