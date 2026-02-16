import { Response, NextFunction } from 'express';
import { ComparisonService } from '../services/comparison';
import { ComparisonFilters } from '../types/comparison.types';
import prisma from '../lib/prisma';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { MAX_PAGINATION_LIMIT, MAX_PAGE } from '../constants/pagination.constants';
import { logger } from '../lib/logger';

export class ComparisonController {
  constructor(private comparisonService: ComparisonService) {}

  private async verifyTenantAccess(jobId: string, tenantId?: string): Promise<boolean> {
    if (!tenantId) return false;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { tenantId: true }
    });

    return job?.tenantId === tenantId;
  }

  /**
   * Validates and normalizes pagination parameters
   *
   * @param page - Raw page number from query string
   * @param limit - Raw limit from query string
   * @param jobId - Job ID for logging purposes
   * @returns Validated pagination object with optional page and limit
   *
   * @remarks
   * - Uses digits-only regex (/^\d+$/) to reject non-integer formats
   * - Rejects: fractional ('10.5'), scientific ('10e2'), negative ('-5'), hex ('0x10')
   * - Accepts: only positive integers ('1', '50', '1000')
   * - Caps page at MAX_PAGE (10000) to prevent excessive offset calculations
   * - Caps limit at MAX_PAGINATION_LIMIT (200) to prevent OOM errors
   * - Logs warnings when limits are capped for telemetry/abuse detection
   */
  private validatePagination(
    page?: string,
    limit?: string,
    jobId?: string
  ): { page?: number; limit?: number } {
    // Enforce digits-only input to reject scientific notation and fractional values
    const digitsOnlyRegex = /^\d+$/;
    const parsedPage = page && digitsOnlyRegex.test(page) ? Number(page) : undefined;
    const parsedLimit = limit && digitsOnlyRegex.test(limit) ? Number(limit) : undefined;

    let validatedPage: number | undefined = undefined;
    if (parsedPage !== undefined && Number.isInteger(parsedPage) && parsedPage > 0) {
      validatedPage = Math.min(parsedPage, MAX_PAGE);

      // Log when page is capped for telemetry/abuse detection
      if (parsedPage > MAX_PAGE) {
        logger.warn('Pagination page capped', {
          requested: parsedPage,
          applied: MAX_PAGE,
          maxOffset: (MAX_PAGE - 1) * MAX_PAGINATION_LIMIT,
          jobId,
        });
      }
    }

    let validatedLimit: number | undefined = undefined;
    if (parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit > 0) {
      validatedLimit = Math.min(parsedLimit, MAX_PAGINATION_LIMIT);

      // Log when limit is capped for telemetry/abuse detection
      if (parsedLimit > MAX_PAGINATION_LIMIT) {
        logger.warn('Pagination limit capped', {
          requested: parsedLimit,
          applied: MAX_PAGINATION_LIMIT,
          jobId,
        });
      }
    }

    return { page: validatedPage, limit: validatedLimit };
  }

  /**
   * Get comparison data for a job with pagination
   *
   * @route GET /api/jobs/:jobId/comparison
   * @param req - Request with jobId param and optional page/limit query params
   * @param res - Response with comparison data
   * @param next - Error handler
   */
  getComparison = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!await this.verifyTenantAccess(jobId, tenantId)) {
        res.status(403).json({ success: false, error: 'Access denied: job belongs to another tenant' });
        return;
      }

      const { page, limit } = this.validatePagination(
        req.query.page as string | undefined,
        req.query.limit as string | undefined,
        jobId
      );

      const data = await this.comparisonService.getComparison(jobId, { page, limit });

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a specific remediation change by ID
   *
   * @route GET /api/jobs/:jobId/comparison/changes/:changeId
   * @param req - Request with jobId and changeId params
   * @param res - Response with change details
   * @param next - Error handler
   */
  getChangeById = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId, changeId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!await this.verifyTenantAccess(jobId, tenantId)) {
        res.status(403).json({ success: false, error: 'Access denied: job belongs to another tenant' });
        return;
      }

      const data = await this.comparisonService.getChangeById(jobId, changeId);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get filtered comparison data with optional filters
   *
   * @route GET /api/jobs/:jobId/comparison/filter
   * @param req - Request with jobId and filter query params
   * @param res - Response with filtered comparison data
   * @param next - Error handler
   *
   * @remarks
   * Supported filters: changeType, severity, status, wcagCriteria, filePath, search
   * Supports pagination via page and limit query params
   */
  getChangesByFilter = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!await this.verifyTenantAccess(jobId, tenantId)) {
        res.status(403).json({ success: false, error: 'Access denied: job belongs to another tenant' });
        return;
      }

      const { page, limit } = this.validatePagination(
        req.query.page as string | undefined,
        req.query.limit as string | undefined,
        jobId
      );

      const filters: ComparisonFilters = {
        changeType: req.query.changeType as string | undefined,
        severity: req.query.severity as string | undefined,
        status: req.query.status as string | undefined,
        wcagCriteria: req.query.wcagCriteria as string | undefined,
        filePath: req.query.filePath as string | undefined,
        search: req.query.search as string | undefined,
        page,
        limit,
      };

      const data = await this.comparisonService.getChangesByFilter(jobId, filters);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}
