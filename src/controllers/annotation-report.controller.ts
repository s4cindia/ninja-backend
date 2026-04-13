import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { annotationReportService } from '../services/calibration/annotation-report.service';
import { annotationTimesheetService } from '../services/calibration/annotation-timesheet.service';
import {
  generateAnnotationAnalysis,
  getStoredAnalysis,
  generateCorpusSummary,
  type MarkCompleteInput,
} from '../services/calibration/annotation-analysis.service';
import { markCompleteBodySchema } from '../schemas/mark-complete.schema';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

function serverError(res: Response, err: unknown, code: string) {
  logger.error(`[AnnotationReportController] ${code}`, err);
  return res.status(500).json({
    success: false,
    error: {
      code,
      message: err instanceof Error ? err.message : 'Internal server error',
    },
  });
}

// ── Session schemas ─────────────────────────────────────────────────

const startSessionSchema = z.object({
  pageNumber: z.number().int().optional(),
});

const endSessionSchema = z.object({
  activeMs: z.number().int().min(0),
  idleMs: z.number().int().min(0),
  zonesReviewed: z.number().int().min(0).default(0),
  zonesConfirmed: z.number().int().min(0).default(0),
  zonesCorrected: z.number().int().min(0).default(0),
  zonesRejected: z.number().int().min(0).default(0),
  sessionLog: z.any().optional(),
});

// ── Controller ──────────────────────────────────────────────────────

class AnnotationReportController {
  /** GET /calibration/runs/:runId/annotation-report */
  async getAnnotationReport(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const report = await annotationReportService.getAnnotationReport(runId);
      if (!report) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.json({ success: true, data: report });
    } catch (err) {
      serverError(res, err, 'GET_ANNOTATION_REPORT_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/annotation-report/export/csv */
  async exportAnnotationCsv(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const csv = await annotationReportService.exportAnnotationCsv(runId);
      if (!csv) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="annotation-report-${runId}.csv"`);
      res.send(csv);
    } catch (err) {
      serverError(res, err, 'EXPORT_ANNOTATION_CSV_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/annotation-report/export/lineage-csv */
  async exportLineageCsv(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const csv = await annotationReportService.exportLineageCsv(runId);
      if (!csv) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="lineage-report-${runId}.csv"`);
      res.send(csv);
    } catch (err) {
      serverError(res, err, 'EXPORT_LINEAGE_CSV_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/annotation-report/export/pdf */
  async exportAnnotationPdf(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const pdfBuffer = await annotationReportService.exportAnnotationPdf(runId);
      if (!pdfBuffer) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="annotation-report-${runId}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      serverError(res, err, 'EXPORT_ANNOTATION_PDF_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/timesheet-report */
  async getTimesheetReport(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const report = await annotationTimesheetService.getTimesheetReport(runId);
      if (!report) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.json({ success: true, data: report });
    } catch (err) {
      serverError(res, err, 'GET_TIMESHEET_REPORT_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/timesheet-report/export/csv */
  async exportTimesheetCsv(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const csv = await annotationTimesheetService.exportTimesheetCsv(runId);
      if (!csv) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="timesheet-report-${runId}.csv"`);
      res.send(csv);
    } catch (err) {
      serverError(res, err, 'EXPORT_TIMESHEET_CSV_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/timesheet-report/export/pdf */
  async exportTimesheetPdf(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const pdfBuffer = await annotationTimesheetService.exportTimesheetPdf(runId);
      if (!pdfBuffer) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration run not found' } });
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="timesheet-report-${runId}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      serverError(res, err, 'EXPORT_TIMESHEET_PDF_FAILED');
    }
  }

  /** POST /calibration/runs/:runId/sessions/start */
  async startSession(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }
      const { runId } = req.params;
      const parsed = startSessionSchema.safeParse(req.body);
      const pageNumber = parsed.success ? parsed.data.pageNumber : undefined;

      const sessionId = await annotationTimesheetService.startSession(runId, req.user.id, pageNumber);
      res.json({ success: true, data: { sessionId } });
    } catch (err) {
      serverError(res, err, 'START_SESSION_FAILED');
    }
  }

  /** POST /calibration/runs/:runId/sessions/:sessionId/end */
  async endSession(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { sessionId } = req.params;
      const parsed = endSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid session data', details: parsed.error.issues },
        });
        return;
      }

      await annotationTimesheetService.endSession(sessionId, parsed.data);
      res.json({ success: true, data: { sessionId } });
    } catch (err) {
      serverError(res, err, 'END_SESSION_FAILED');
    }
  }

  /** POST /calibration/runs/:runId/complete — Mark annotation complete + generate analysis */
  async markAnnotationComplete(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;

      // Check run existence FIRST so a missing runId always returns 404,
      // regardless of whether the body is also malformed. The previous order
      // meant {runId: nonexistent, body: bad} returned 422 instead of 404,
      // making client-side error handling depend on payload shape.
      const run = await prisma.calibrationRun.findUnique({
        where: { id: runId },
        select: { corpusDocument: { select: { pageCount: true } } },
      });
      if (!run) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Calibration run not found' },
        });
        return;
      }
      const pageCount = run.corpusDocument?.pageCount ?? null;

      // Backwards-compatible body parsing: empty body or any subset is allowed.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const parsed = markCompleteBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid mark-complete payload',
            details: parsed.error.issues,
          },
        });
        return;
      }

      if (typeof parsed.data.pagesReviewed === 'number' && pageCount != null && parsed.data.pagesReviewed > pageCount) {
        res.status(422).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `pagesReviewed (${parsed.data.pagesReviewed}) exceeds document page count (${pageCount})`,
            details: [{ path: ['pagesReviewed'], message: 'must be ≤ document page count' }],
          },
        });
        return;
      }

      // Per-issue bound check: an individual issue cannot claim to affect more
      // pages than the document actually has.
      if (pageCount != null && Array.isArray(parsed.data.issues)) {
        for (let i = 0; i < parsed.data.issues.length; i++) {
          const iss = parsed.data.issues[i]!;
          if (typeof iss.pagesAffected === 'number' && iss.pagesAffected > pageCount) {
            res.status(422).json({
              success: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: `issues[${i}].pagesAffected (${iss.pagesAffected}) exceeds document page count (${pageCount})`,
                details: [{ path: ['issues', i, 'pagesAffected'], message: 'must be ≤ document page count' }],
              },
            });
            return;
          }
        }
      }

      const input: MarkCompleteInput = {
        pagesReviewed: parsed.data.pagesReviewed,
        issues: parsed.data.issues,
        notes: parsed.data.notes,
      };

      const result = await generateAnnotationAnalysis(runId, input);
      res.json({ success: true, data: result });
    } catch (err) {
      serverError(res, err, 'MARK_COMPLETE_FAILED');
    }
  }

  /** GET /calibration/runs/:runId/analysis — Get stored analysis report */
  async getAnalysis(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const { runId } = req.params;
      const result = await getStoredAnalysis(runId);
      if (!result) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No analysis report found for this run' } });
        return;
      }
      res.json({ success: true, data: result });
    } catch (err) {
      serverError(res, err, 'GET_ANALYSIS_FAILED');
    }
  }

  /** GET /calibration/corpus/analysis-summary — Cross-title corpus summary */
  async getCorpusSummary(_req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const result = await generateCorpusSummary();
      res.json({ success: true, data: result });
    } catch (err) {
      serverError(res, err, 'CORPUS_SUMMARY_FAILED');
    }
  }
}

export const annotationReportController = new AnnotationReportController();
