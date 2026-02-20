import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { queueService } from '../services/queue.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { JobType } from '../queues';
import { workflowService } from '../services/workflow/workflow.service';
import { workflowConfigService } from '../services/workflow/workflow-config.service';
import { logger } from '../lib/logger';

/**
 * Represents the normalized structure of a job's output data.
 * Contains accessibility validation results and issue summaries.
 */
interface JobOutput {
  /** Accessibility score from 0-100 */
  score?: number;
  /** Whether the document is structurally valid */
  isValid?: boolean;
  /** Whether the document meets accessibility requirements */
  isAccessible?: boolean;
  /** Summary counts of issues by severity level */
  summary?: {
    total?: number;
    critical?: number;
    serious?: number;
    moderate?: number;
    minor?: number;
  };
  /** Array of all accessibility issues found */
  combinedIssues?: unknown[];
  [key: string]: unknown;
}

/**
 * Normalizes job output to ensure consistent structure with default values.
 * Prevents null/undefined errors when accessing output properties.
 * Spreads raw output first, then overrides with normalized values to ensure
 * required fields always have valid defaults.
 * @param output - Raw output data from the job, may be null or incomplete
 * @returns Normalized output with all required fields populated
 */
function normalizeJobOutput(output: unknown): JobOutput {
  const rawOutput = (output && typeof output === 'object' && !Array.isArray(output))
    ? (output as JobOutput)
    : {};
  
  const rawSummary = rawOutput.summary && typeof rawOutput.summary === 'object'
    ? rawOutput.summary
    : {};

  return {
    ...rawOutput,
    score: typeof rawOutput.score === 'number' ? rawOutput.score : 0,
    isValid: typeof rawOutput.isValid === 'boolean' ? rawOutput.isValid : false,
    isAccessible: typeof rawOutput.isAccessible === 'boolean' ? rawOutput.isAccessible : false,
    summary: {
      total: typeof rawSummary.total === 'number' ? rawSummary.total : 0,
      critical: typeof rawSummary.critical === 'number' ? rawSummary.critical : 0,
      serious: typeof rawSummary.serious === 'number' ? rawSummary.serious : 0,
      moderate: typeof rawSummary.moderate === 'number' ? rawSummary.moderate : 0,
      minor: typeof rawSummary.minor === 'number' ? rawSummary.minor : 0,
    },
    combinedIssues: Array.isArray(rawOutput.combinedIssues) ? rawOutput.combinedIssues : [],
  };
}

/**
 * Controller for managing accessibility validation jobs.
 * Handles job creation, listing, status checking, and results retrieval.
 */
export class JobController {
  /**
   * Creates a new validation job.
   * @param req - Request with job type, fileId, productId, priority, options in body
   * @param res - Response with created job data
   * @param next - Next function for error handling
   */
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

      // ═══════════════════════════════════════════════════════════════
      // 🔄 Sprint 9.1: Conditionally create workflow for this job
      // ═══════════════════════════════════════════════════════════════
      let workflowId: string | undefined;
      try {
        if (fileId) {
          // Check if workflow is enabled for this tenant/job
          const shouldCreate = await workflowConfigService.shouldCreateWorkflow(
            req.user.tenantId,
            options?.workflow
          );

          if (shouldCreate) {
            logger.info(`[Job Controller] Creating workflow for job ${jobId}, file ${fileId}`);
            const workflow = await workflowService.createWorkflow(fileId, req.user.id);
            workflowId = workflow.id;
            logger.info(`[Job Controller] Workflow created: ${workflowId}, state: ${workflow.currentState}`);
          } else {
            logger.info(`[Job Controller] Workflow disabled for tenant ${req.user.tenantId}, skipping creation`);
          }
        } else {
          logger.warn(`[Job Controller] No fileId provided, skipping workflow creation for job ${jobId}`);
        }
      } catch (workflowError) {
        // Don't fail the job creation if workflow creation fails
        logger.error(`[Job Controller] Failed to create workflow for job ${jobId}`, workflowError);
      }

      res.status(201).json({
        success: true,
        data: {
          ...job,
          workflowId, // Include workflow ID in response
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lists all jobs for the authenticated user's tenant.
   * Supports pagination and filtering by status/type.
   * @param req - Request with optional query params: page, limit, status, type
   * @param res - Response with paginated jobs list and normalized output
   */
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
            output: true,
            error: true,
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

      const normalizedJobs = jobs.map(job => ({
        ...job,
        output: normalizeJobOutput(job.output),
      }));

      res.json({
        success: true,
        data: {
          jobs: normalizedJobs,
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

  /**
   * Gets a single job by ID with full status information.
   * @param req - Request with job ID in params
   * @param res - Response with job data including queue status
   */
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

  /**
   * Gets lightweight status information for a job.
   * Returns only status, progress, and timing data for polling.
   * @param req - Request with job ID in params
   * @param res - Response with job status data
   */
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

  /**
   * Gets the full results of a completed job.
   * Includes normalized output and validation results with issues.
   * @param req - Request with job ID in params
   * @param res - Response with job results and validation data
   * @throws 400 if job is not yet completed
   */
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
          output: normalizeJobOutput(job.output),
          validationResults: job.validationResults,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Cancels a pending or processing job.
   * @param req - Request with job ID in params
   * @param res - Response with success confirmation
   */
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

  /**
   * Gets job statistics for the tenant's dashboard.
   * Returns counts by status and type, plus recent jobs.
   * @param req - Request object (uses tenant from authenticated user)
   * @param res - Response with aggregated job statistics
   */
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
