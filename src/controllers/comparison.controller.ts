import { Request, Response, NextFunction } from 'express';
import { ComparisonService } from '../services/comparison';
import { ComparisonFilters } from '../types/comparison.types';

export class ComparisonController {
  constructor(private comparisonService: ComparisonService) {}

  getComparison = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId } = req.params;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const data = await this.comparisonService.getComparison(jobId, { page, limit });

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getChangeById = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId, changeId } = req.params;

      const data = await this.comparisonService.getChangeById(jobId, changeId);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getChangesByFilter = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { jobId } = req.params;
      const filters: ComparisonFilters = {
        changeType: req.query.changeType as string | undefined,
        severity: req.query.severity as string | undefined,
        status: req.query.status as string | undefined,
        wcagCriteria: req.query.wcagCriteria as string | undefined,
        filePath: req.query.filePath as string | undefined,
        search: req.query.search as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      };

      const data = await this.comparisonService.getChangesByFilter(jobId, filters);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}
