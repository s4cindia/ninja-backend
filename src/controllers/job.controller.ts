import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { queueService } from '../services/queue.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { JobType } from '../queues';

export class JobController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const { type, fileId, productId, priority, options } = req.body;

      const jobId = await queueService.createJob({
        type: type as JobType,
        tenantId: req.user.tenantId,
        userId: req.user.id,
        fileId,
        productId,
        priority,
        options,
      });

      const job = await queueService.getJobStatus(jobId, req.user.tenantId);

      res.status(201).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const { 
        page = '1', 
        limit = '20', 
        status, 
        type 
      } = req.query;

      let pageNum = parseInt(page as string, 10);
      let limitNum = parseInt(limit as string, 10);
      
      if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
      if (isNaN(limitNum) || limitNum < 1) limitNum = 20;
      if (limitNum > 100) limitNum = 100;
      
      const skip = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = {
        tenantId: req.user.tenantId,
      };

      if (status) {
        where.status = status;
      }

      if (type) {
        where.type = type;
      }

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            status: true,
            progress: true,
            priority: true,
            input: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            productId: true,
            userId: true,
            product: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        }),
        prisma.job.count({ where }),
      ]);

      res.json({
        success: true,
        data: {
          jobs,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const job = await queueService.getJobStatus(req.params.id, req.user.tenantId);

      res.json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const job = await prisma.job.findFirst({
        where: {
          id: req.params.id,
          tenantId: req.user.tenantId,
        },
        select: {
          id: true,
          status: true,
          progress: true,
          error: true,
          startedAt: true,
          completedAt: true,
        },
      });

      if (!job) {
        throw AppError.notFound('Job not found', ErrorCodes.JOB_NOT_FOUND);
      }

      res.json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  async getResults(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const job = await prisma.job.findFirst({
        where: {
          id: req.params.id,
          tenantId: req.user.tenantId,
        },
        select: {
          id: true,
          type: true,
          status: true,
          output: true,
          completedAt: true,
          validationResults: {
            select: {
              id: true,
              category: true,
              checkType: true,
              passed: true,
              score: true,
              details: true,
              issues: {
                select: {
                  id: true,
                  severity: true,
                  wcagCriteria: true,
                  description: true,
                  location: true,
                  suggestion: true,
                  autoFixable: true,
                },
              },
            },
          },
        },
      });

      if (!job) {
        throw AppError.notFound('Job not found', ErrorCodes.JOB_NOT_FOUND);
      }

      if (job.status !== 'COMPLETED') {
        throw AppError.badRequest(
          'Job results not available. Job status: ' + job.status,
          ErrorCodes.JOB_NOT_FOUND
        );
      }

      res.json({
        success: true,
        data: {
          jobId: job.id,
          type: job.type,
          completedAt: job.completedAt,
          output: job.output,
          validationResults: job.validationResults,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      await queueService.cancelJob(req.params.id, req.user.tenantId);

      res.json({
        success: true,
        message: 'Job cancelled successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const [byStatus, byType, recent] = await Promise.all([
        prisma.job.groupBy({
          by: ['status'],
          where: { tenantId: req.user.tenantId },
          _count: true,
        }),
        prisma.job.groupBy({
          by: ['type'],
          where: { tenantId: req.user.tenantId },
          _count: true,
        }),
        prisma.job.findMany({
          where: { tenantId: req.user.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            type: true,
            status: true,
            createdAt: true,
          },
        }),
      ]);

      res.json({
        success: true,
        data: {
          byStatus: byStatus.reduce((acc, item) => {
            acc[item.status] = item._count;
            return acc;
          }, {} as Record<string, number>),
          byType: byType.reduce((acc, item) => {
            acc[item.type] = item._count;
            return acc;
          }, {} as Record<string, number>),
          recentJobs: recent,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const jobController = new JobController();
