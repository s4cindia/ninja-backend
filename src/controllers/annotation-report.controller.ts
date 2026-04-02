import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { annotationReportService } from '../services/calibration/annotation-report.service';
import { annotationTimesheetService } from '../services/calibration/annotation-timesheet.service';
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
}

export const annotationReportController = new AnnotationReportController();
