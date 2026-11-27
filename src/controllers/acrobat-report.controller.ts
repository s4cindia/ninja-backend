/**
 * Acrobat Report Controller
 *
 * Job-scoped endpoints for the Acrobat Pro accessibility report (EPUB-from-
 * certified-PDF certification evidence). Same response envelope as
 * pac-report.controller.ts's external-report handlers, except AppError
 * `details` are passed through: the 422 ACROBAT_REPORT_COUNTS_REQUIRED
 * response carries the parse result the UI pre-fills the counts form from.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { logger } from '../lib/logger';
import { AppError } from '../utils/app-error';
import {
  getJobAcrobatReportUploadUrl,
  confirmJobAcrobatReportUpload,
  getJobAcrobatReport,
  deleteJobAcrobatReport,
} from '../services/certification/job-acrobat-report.service';
import type { JobAcrobatReportUploadUrlBody, JobAcrobatReportConfirmBody } from '../schemas/job-acrobat-report.schemas';

function sendError(res: Response, err: unknown, fallbackMessage: string, logLabel: string): Response {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      data: {},
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  logger.error(`[AcrobatReport] ${logLabel} failed`, err as Error);
  return res.status(500).json({
    success: false,
    data: {},
    error: { code: 'INTERNAL_ERROR', message: fallbackMessage, details: null },
  });
}

export class AcrobatReportController {
  /** POST /api/v1/pdf/:jobId/acrobat-report/upload-url */
  async getUploadUrl(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { filename } = req.body as JobAcrobatReportUploadUrlBody;
      const result = await getJobAcrobatReportUploadUrl(req.params.jobId, filename);
      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      return sendError(res, err, 'Failed to generate upload URL', 'getUploadUrl');
    }
  }

  /** POST /api/v1/pdf/:jobId/acrobat-report/confirm */
  async confirmUpload(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { uploadId, originalFileName, operatorCounts } = req.body as JobAcrobatReportConfirmBody;
      const result = await confirmJobAcrobatReportUpload(req.params.jobId, {
        uploadId,
        originalFileName,
        operatorCounts,
        uploadedById: req.user!.id,
      });
      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      return sendError(res, err, 'Failed to confirm Acrobat report upload', 'confirmUpload');
    }
  }

  /** GET /api/v1/pdf/:jobId/acrobat-report -- null (not 404) when none uploaded. */
  async getReport(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const report = await getJobAcrobatReport(req.params.jobId);
      return res.status(200).json({ success: true, data: report });
    } catch (err) {
      return sendError(res, err, 'Failed to load Acrobat report', 'getReport');
    }
  }

  /** DELETE /api/v1/pdf/:jobId/acrobat-report */
  async deleteReport(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const deleted = await deleteJobAcrobatReport(req.params.jobId);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          data: {},
          error: { code: 'NOT_FOUND', message: 'No Acrobat report attached to this job', details: null },
        });
      }
      return res.status(200).json({ success: true, data: { deleted: true } });
    } catch (err) {
      return sendError(res, err, 'Failed to delete Acrobat report', 'deleteReport');
    }
  }
}

export const acrobatReportController = new AcrobatReportController();
