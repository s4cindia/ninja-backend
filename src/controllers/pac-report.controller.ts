/**
 * PAC Report Controller
 *
 * Handles HTTP requests for Matterhorn Protocol 1.1 compliance reports.
 * Matterhorn Coverage Plan — Step 5
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { logger } from '../lib/logger';
import { pacReportService } from '../services/pdf/pac-report.service';

export class PacReportController {
  /**
   * GET /api/v1/pdf/:jobId/pac-report
   * Returns the full 137-condition PAC-equivalent report as JSON.
   */
  async getReport(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          data: {},
          error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: null },
        });
      }

      const report = await pacReportService.generateReport(jobId, tenantId);

      return res.status(200).json({ success: true, data: report });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      logger.error(`[PacReport] getReport failed`, error);

      const statusCode = error.statusCode ?? 500;
      const isNotFound = statusCode === 404;
      return res.status(statusCode).json({
        success: false,
        data: {},
        error: {
          code: isNotFound ? 'JOB_NOT_FOUND' : 'INTERNAL_ERROR',
          message: isNotFound ? error.message ?? 'Job not found' : 'Failed to generate PAC report',
          details: null,
        },
      });
    }
  }
}

export const pacReportController = new PacReportController();
