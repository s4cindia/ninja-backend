import { Request, Response, NextFunction } from 'express';
import { timeReportService, AggregateFilters } from '../services/metrics/time-report.service';
import { logger } from '../lib/logger';

function serverError(res: Response, err: unknown, code: string) {
  logger.error(`[MetricsController] ${code}`, err);
  return res.status(500).json({
    success: false,
    error: {
      code,
      message: err instanceof Error ? err.message : 'Internal server error',
    },
  });
}

class MetricsController {
  /** GET /api/v1/metrics/workflows/:workflowId */
  async getWorkflowDetailReport(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }
      const { workflowId } = req.params;
      const report = await timeReportService.getWorkflowDetailReport(workflowId, req.user.tenantId);
      if (!report) {
        res.status(404).json({ success: false, error: { message: 'Workflow not found or access denied' } });
        return;
      }
      res.json({ success: true, data: report });
    } catch (err) {
      serverError(res, err, 'GET_WORKFLOW_DETAIL_REPORT_FAILED');
    }
  }

  /** GET /api/v1/metrics/batches/:batchId */
  async getBatchDetailReport(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }
      const { batchId } = req.params;
      const fileType = req.query.fileType as string | undefined;
      const report = await timeReportService.getBatchDetailReport(batchId, req.user.tenantId, fileType);
      if (!report) {
        res.status(404).json({ success: false, error: { message: 'Batch not found or access denied' } });
        return;
      }
      res.json({ success: true, data: report });
    } catch (err) {
      serverError(res, err, 'GET_BATCH_DETAIL_REPORT_FAILED');
    }
  }

  /** GET /api/v1/metrics/aggregate */
  async getAggregateReport(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }

      const filters = this.parseFilters(req, req.user.tenantId);
      const report = await timeReportService.getAggregateReport(filters);
      res.json({ success: true, data: report });
    } catch (err) {
      serverError(res, err, 'GET_AGGREGATE_REPORT_FAILED');
    }
  }

  /** GET /api/v1/metrics/aggregate/export */
  async exportAggregateCsv(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }

      const filters = this.parseFilters(req, req.user.tenantId);
      const csv = await timeReportService.exportAggregateCsv(filters);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="time-metrics.csv"');
      res.send(csv);
    } catch (err) {
      serverError(res, err, 'EXPORT_AGGREGATE_CSV_FAILED');
    }
  }

  private parseFilters(req: Request, tenantId: string): AggregateFilters {
    const { from, to, workflowType, fileType } = req.query as Record<string, string | undefined>;

    const filters: AggregateFilters = { tenantId };

    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) filters.from = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) filters.to = d;
    }
    if (workflowType === 'MANUAL' || workflowType === 'AGENTIC') {
      filters.workflowType = workflowType;
    }
    if (fileType) filters.fileType = fileType;

    return filters;
  }
}

export const metricsController = new MetricsController();
