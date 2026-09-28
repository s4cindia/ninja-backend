/**
 * PAC Report Controller
 *
 * Handles HTTP requests for Matterhorn Protocol 1.1 compliance reports.
 * Matterhorn Coverage Plan — Step 5
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';
import { pacReportService } from '../services/pdf/pac-report.service';
import { axes4PacService } from '../services/pdf/axes4-pac.service';
import { fileStorageService } from '../services/storage/file-storage.service';

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

  /**
   * POST /api/v1/pdf/:jobId/pac-report/live
   * Runs the job's document through axes4's real, external PAC Cloud
   * checker -- deliberately separate from GET /pac-report above, which
   * returns Ninja's own free, instant, simulated Matterhorn report. This one
   * costs real money per page and can take minutes, so it is never called
   * automatically; a client must explicitly POST here to opt into it.
   *
   * Always responds 200 with `data.ran` telling the caller whether axes4
   * actually ran -- including when it's simply not configured yet (no
   * AXES4_API_KEY/AXES4_SUBSCRIPTION_ID set, the case for every environment
   * until a real axes4 subscription exists). That is an expected, common
   * state, not a server error, so it is not surfaced as one.
   */
  async getLiveReport(req: AuthenticatedRequest, res: Response): Promise<Response> {
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

      const job = await prisma.job.findFirst({ where: { id: jobId, tenantId } });
      if (!job) {
        return res.status(404).json({
          success: false,
          data: {},
          error: { code: 'JOB_NOT_FOUND', message: 'Job not found or access denied', details: null },
        });
      }

      const input = job.input as { fileName?: string } | null;
      const output = job.output as Record<string, unknown> | null;
      const fileName = input?.fileName || 'document.pdf';

      // Prefer the remediated document (what a real compliance check should
      // actually verify) over the original upload, same preference order
      // pdf-remediation.controller.ts's own download endpoint already
      // established -- see that file's own comment on why
      // fileStorageService (not raw disk/S3 access) is the right
      // abstraction here.
      let buffer: Buffer | null = null;
      let source: 'remediated' | 'original' | null = null;
      try {
        if (output?.['remediatedFileUrl'] && typeof output['remediatedFileUrl'] === 'string') {
          buffer = await fileStorageService.downloadFile(output['remediatedFileUrl'] as string);
        } else {
          buffer = await fileStorageService.getRemediatedFile(jobId, fileName);
        }
        if (buffer) source = 'remediated';
      } catch (err) {
        // No remediated file yet -- fall through to the original upload below.
        logger.warn(`[PacReport] getLiveReport found no remediated file for job ${jobId}, falling back to original upload`, err);
      }
      if (!buffer) {
        try {
          buffer = await fileStorageService.getFile(jobId, fileName);
          if (buffer) source = 'original';
        } catch (err) {
          logger.error(`[PacReport] getLiveReport could not load any file for job ${jobId}`, err);
        }
      }

      if (!buffer) {
        return res.status(404).json({
          success: false,
          data: {},
          error: { code: 'FILE_NOT_FOUND', message: 'Could not load a document for this job', details: null },
        });
      }

      const result = await axes4PacService.validate(buffer, fileName);

      return res.status(200).json({
        success: true,
        data: {
          ran: result.ran,
          uaIndex: result.uaIndex,
          failures: result.failures,
          configured: axes4PacService.isAvailable(),
          source,
        },
      });
    } catch (err: unknown) {
      const error = err as Error;
      logger.error(`[PacReport] getLiveReport failed`, error);
      return res.status(500).json({
        success: false,
        data: {},
        error: { code: 'INTERNAL_ERROR', message: 'Failed to run the live PAC Cloud check', details: null },
      });
    }
  }
}

export const pacReportController = new PacReportController();
