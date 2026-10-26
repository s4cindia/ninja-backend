import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { queueService } from '../services/queue.service';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { JobType } from '../queues';
import { workflowService } from '../services/workflow/workflow.service';
import { workflowConfigService } from '../services/workflow/workflow-config.service';
import { logger } from '../lib/logger';
import { s3Service } from '../services/s3.service';
import { isAuthenticated } from '../utils/auth';

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
 * Flattens a PDF accessibility audit's nested `auditReport` (written by
 * accessibility.processor.ts's single-file path and
 * pdf-batch-orchestrator.service.ts's batch path -- both persist
 * `output: { auditReport: AuditReport, ... }`, never flat top-level
 * score/summary/combinedIssues) onto the output's own top level.
 *
 * Real incident (2026-10-20): the generic Jobs > :jobId detail page
 * (JobDetails.tsx, via parseJobOutput) only ever reads flat top-level
 * fields -- a shape contract that matches EPUB's own audit output
 * (epub-audit.service.ts spreads its EpubAuditResult, which already has
 * score/summary/combinedIssues at the top level) but has never matched a
 * PDF audit job's output. Every PDF_ACCESSIBILITY job (batch-sourced or
 * single-file upload, confirmed by reading both writers) rendered
 * "Score 0 / No detailed issues available" on that page despite the real
 * audit data sitting one level down, under `auditReport`.
 *
 * Only triggers when the top-level score/combinedIssues are absent, so an
 * already-flat shape (or a future writer that flattens at write-time) is
 * left untouched, and other PDF-specific consumers that read
 * `output.auditReport` directly (PdfAuditResultsPage.tsx, re-audit, PAC
 * report, ACR analysis) are unaffected since auditReport itself is never
 * removed.
 */
function flattenPdfAuditReport(rawOutput: JobOutput): JobOutput {
  if (typeof rawOutput.score === 'number' || Array.isArray(rawOutput.combinedIssues)) {
    return rawOutput;
  }

  const auditReport = rawOutput.auditReport;
  if (!auditReport || typeof auditReport !== 'object' || Array.isArray(auditReport)) {
    return rawOutput;
  }

  const report = auditReport as Record<string, unknown>;
  if (typeof report.score !== 'number' || !Array.isArray(report.issues)) {
    return rawOutput;
  }

  const summary = report.summary && typeof report.summary === 'object'
    ? report.summary as Record<string, unknown>
    : {};
  const critical = typeof summary.critical === 'number' ? summary.critical : 0;

  return {
    ...rawOutput,
    score: report.score,
    // No PDF-report equivalent of EPUB's own "isValid" concept -- a
    // successfully generated AuditReport means parsing/validation ran to
    // completion, so treat that as valid rather than defaulting to the
    // misleading "false" a job that never set this field would otherwise get.
    isValid: true,
    // Same accessibility threshold EPUB audits already use
    // (epub-audit.service.ts), reused here for a consistent definition
    // across audit types rather than inventing a second one.
    isAccessible: report.score >= 70 && critical === 0,
    summary: {
      total: typeof summary.total === 'number' ? summary.total : 0,
      critical,
      serious: typeof summary.serious === 'number' ? summary.serious : 0,
      moderate: typeof summary.moderate === 'number' ? summary.moderate : 0,
      minor: typeof summary.minor === 'number' ? summary.minor : 0,
    },
    combinedIssues: report.issues,
  };
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
  const rawOutput = flattenPdfAuditReport(
    (output && typeof output === 'object' && !Array.isArray(output))
      ? (output as JobOutput)
      : {}
  );

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
      if (!isAuthenticated(req)) {
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
      if (!isAuthenticated(req)) {
        throw AppError.unauthorized('Not authenticated');
      }

      await this.respondWithJobList(req, res, { tenantId: req.user.tenantId });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lists jobs owned by any member (any TeamRole, including EXECUTIVE) of a
   * team the caller leads or views (TeamMembership.teamRole TEAM_LEADER or
   * VIEWER) -- RBAC Phase 3's discovery endpoint. Phase 2's
   * authorizeJobForReview only grants read access to a teammate's job once
   * the caller already knows its jobId; this is what lets a Team
   * Leader/Viewer actually browse their team's jobs in the first place.
   *
   * Deliberately separate from, and does not alter, GET /jobs (list()
   * above), which remains tenant-wide for every caller regardless of team
   * membership -- narrowing that is a distinct, bigger decision the team
   * explicitly deferred.
   */
  async listTeamJobs(req: Request, res: Response, next: NextFunction) {
    try {
      if (!isAuthenticated(req)) {
        throw AppError.unauthorized('Not authenticated');
      }

      const callerTeams = await prisma.teamMembership.findMany({
        where: {
          userId: req.user.id,
          teamRole: { in: ['TEAM_LEADER', 'VIEWER'] },
        },
        select: { teamId: true },
      });

      if (callerTeams.length === 0) {
        throw AppError.forbidden(
          'You must be a Team Leader or Viewer on at least one team to view team jobs',
          'NOT_TEAM_LEADER_OR_VIEWER'
        );
      }

      const teamIds = callerTeams.map((m) => m.teamId);
      const teammates = await prisma.teamMembership.findMany({
        where: { teamId: { in: teamIds } },
        select: { userId: true },
        distinct: ['userId'],
      });
      const memberUserIds = [...new Set(teammates.map((m) => m.userId))];

      await this.respondWithJobList(req, res, {
        tenantId: req.user.tenantId,
        userId: { in: memberUserIds },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Shared pagination/filtering/response logic for list() and
   * listTeamJobs(). `baseWhere` always carries tenantId (and, for the
   * team-scoped caller, a userId-in filter), ANDed with the optional
   * status/type query filters below -- kept explicit at each call site
   * rather than folded into this helper, so tenant isolation stays
   * auditable by inspection at the call site.
   */
  private async respondWithJobList(
    req: Request,
    res: Response,
    baseWhere: Record<string, unknown>
  ): Promise<void> {
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

    const where: Record<string, unknown> = { ...baseWhere };

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
          // Added for listTeamJobs' "Owner" column -- without this, the
          // frontend only has the raw userId to show (see RBAC frontend
          // PR #360's "Known limitation" note). Harmless to also include on
          // the tenant-wide list() path above; both already return the raw
          // userId today.
          user: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          product: {
            select: {
              id: true,
              title: true,
            },
          },
          editorialDocument: {
            select: { id: true, originalName: true },
          },
        },
      }),
      prisma.job.count({ where }),
    ]);

    const normalizedJobs = jobs.map(({ editorialDocument, ...rest }) => {
      const output = normalizeJobOutput(rest.output);
      // Include document filename in output so frontend can display it
      if (editorialDocument?.originalName && !output.fileName) {
        output.fileName = editorialDocument.originalName;
      }
      return {
        ...rest,
        output,
        // Include documentId so frontend can navigate to the correct editor
        ...(editorialDocument?.id && { documentId: editorialDocument.id }),
      };
    });

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
  }

  /**
   * Gets a single job by ID with full status information.
   * @param req - Request with job ID in params
   * @param res - Response with job data including queue status
   */
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      if (!isAuthenticated(req)) {
        throw AppError.unauthorized('Not authenticated');
      }

      const job = await queueService.getJobStatus(req.params.id, req.user.tenantId);

      res.json({
        success: true,
        data: {
          ...job,
          // Unlike list()/getResults(), this endpoint previously returned
          // job.output completely raw with no normalization at all -- the
          // generic Jobs > :jobId detail page (JobDetails.tsx) is the one
          // that actually hits this endpoint, so it got neither this
          // function's PDF auditReport flattening nor its missing-field
          // defaults.
          output: normalizeJobOutput(job.output),
        },
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
      if (!isAuthenticated(req)) {
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
      if (!isAuthenticated(req)) {
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
      if (!isAuthenticated(req)) {
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
   * Permanently deletes a job and all associated data.
   */
  async permanentDelete(req: Request, res: Response, next: NextFunction) {
    try {
      if (!isAuthenticated(req)) {
        throw AppError.unauthorized('Not authenticated');
      }

      const { id: jobId } = req.params;
      const { tenantId } = req.user;

      const job = await prisma.job.findFirst({
        where: { id: jobId, tenantId },
        include: { editorialDocument: { select: { id: true, storagePath: true } } },
      });

      if (!job) {
        throw AppError.notFound('Job not found', ErrorCodes.JOB_NOT_FOUND);
      }

      // Best-effort: cancel any in-flight BullMQ work before removing DB records
      try {
        await queueService.cancelJob(jobId, tenantId);
      } catch (err) {
        const isExpected = err instanceof AppError && (err.statusCode === 404 || err.statusCode === 400);
        if (isExpected) {
          logger.debug(`[Job] Queue cancellation skipped for ${jobId} (likely already finished)`);
        } else {
          logger.warn(`[Job] Unexpected queue cancellation error for ${jobId}:`, err instanceof Error ? err : undefined);
        }
      }

      // Capture storage path before transaction deletes the document record
      const storagePath = job.editorialDocument?.storagePath;

      await prisma.$transaction(async (tx) => {
        if (job.editorialDocument) {
          const docId = job.editorialDocument.id;
          await tx.citationChange.deleteMany({ where: { documentId: docId } });
          await tx.referenceListEntryCitation.deleteMany({ where: { citation: { documentId: docId } } });
          await tx.citation.deleteMany({ where: { documentId: docId } });
          await tx.referenceListEntry.deleteMany({ where: { documentId: docId } });
          await tx.editorialDocumentContent.deleteMany({ where: { documentId: docId } });
          await tx.editorialDocument.delete({ where: { id: docId } });
        }
        // Delete Issue rows before ValidationResult (Issue has FK to ValidationResult, no cascade)
        const vrIds = await tx.validationResult.findMany({ where: { jobId }, select: { id: true } });
        if (vrIds.length > 0) {
          await tx.issue.deleteMany({ where: { validationResultId: { in: vrIds.map(v => v.id) } } });
        }
        await tx.validationResult.deleteMany({ where: { jobId } });
        await tx.artifact.deleteMany({ where: { jobId } });
        await tx.remediationChange.deleteMany({ where: { jobId } });
        await tx.job.delete({ where: { id: jobId } });
      });

      // Clean up S3 file after DB commit so a failed transaction doesn't orphan data
      if (storagePath) {
        try {
          await s3Service.deleteFile(storagePath);
        } catch (s3Error) {
          logger.warn(`[Job] Failed to delete S3 file ${storagePath}:`, s3Error);
        }
      }

      logger.info(`[Job] Permanently deleted job ${jobId}`);

      res.json({ success: true, data: { jobId } });
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
      if (!isAuthenticated(req)) {
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
