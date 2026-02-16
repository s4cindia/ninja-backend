import { Response, NextFunction } from 'express';
import { ComparisonService } from '../services/comparison';
import { ComparisonFilters } from '../types/comparison.types';
import prisma from '../lib/prisma';
import { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Maximum number of records to return per page
 * Prevents OOM errors and excessive query times for large result sets
 * Must match MAX_PAGINATION_LIMIT in comparison.service.ts
 */
const MAX_PAGINATION_LIMIT = 200;

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

      const parsedPage = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const page = parsedPage !== undefined && Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : undefined;
      const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_PAGINATION_LIMIT)
        : undefined;

      const data = await this.comparisonService.getComparison(jobId, { page, limit });

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

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

      const parsedPage = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const filters: ComparisonFilters = {
        changeType: req.query.changeType as string | undefined,
        severity: req.query.severity as string | undefined,
        status: req.query.status as string | undefined,
        wcagCriteria: req.query.wcagCriteria as string | undefined,
        filePath: req.query.filePath as string | undefined,
        search: req.query.search as string | undefined,
        page: parsedPage !== undefined && Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : undefined,
        limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(parsedLimit, MAX_PAGINATION_LIMIT)
          : undefined,
      };

      const data = await this.comparisonService.getChangesByFilter(jobId, filters);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}
