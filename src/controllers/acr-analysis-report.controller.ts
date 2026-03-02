import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { AppError } from '../utils/app-error';
import { reportGeneratorService } from '../services/acr/report-generator.service';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

const SHARE_TOKEN_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

class AcrAnalysisReportController {
  /**
   * GET /api/v1/acr/reports/:jobId/analysis
   * Generate and return the full AI Analysis Report for a job.
   * Results are cached in Redis for 1 hour.
   */
  async getAnalysisReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const { jobId } = req.params;

      logger.info(`[AcrAnalysisReport] Generating report for job ${jobId}, tenant ${req.user.tenantId}`);

      const report = await reportGeneratorService.generateAnalysisReport(jobId, req.user.tenantId);

      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/acr/reports/:jobId/invalidate
   * Invalidate the cached report for a job (admin/internal use).
   */
  async invalidateReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const { jobId } = req.params;
      await reportGeneratorService.invalidateCache(jobId);

      res.json({ success: true, message: 'Report cache invalidated' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/acr/reports/:jobId/share
   * Create a 7-day share token for the report. Returns the token (frontend
   * constructs the full share URL).
   */
  async createShareToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const { jobId } = req.params;

      // Verify job belongs to this tenant
      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!job) throw AppError.notFound('Job not found');

      const token = randomUUID();
      const redis = getRedisClient();
      await redis.setex(
        `share:report:${token}`,
        SHARE_TOKEN_TTL,
        JSON.stringify({ jobId, tenantId: req.user.tenantId })
      );

      const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL * 1000);

      logger.info(`[AcrAnalysisReport] Share token created for job ${jobId}`);

      res.json({ success: true, data: { token, expiresAt } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/acr/reports/shared/:token
   * Public endpoint — no auth required. Validates share token then returns report.
   */
  async getSharedReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token } = req.params;
      const redis = getRedisClient();
      const raw = await redis.get(`share:report:${token}`);

      if (!raw) {
        throw AppError.unauthorized('Share link has expired or is invalid');
      }

      const { jobId, tenantId } = JSON.parse(raw) as { jobId: string; tenantId: string };

      const report = await reportGeneratorService.generateAnalysisReport(jobId, tenantId);

      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  }
}

export const acrAnalysisReportController = new AcrAnalysisReportController();
