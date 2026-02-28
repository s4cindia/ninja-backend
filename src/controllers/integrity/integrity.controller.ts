/**
 * Integrity Check Controller
 *
 * Handles integrity check API requests:
 * - Start integrity check jobs
 * - Get job status
 * - Get issues (filtered, paginated)
 * - Get summary
 * - Apply fix / ignore / bulk actions
 */

import { Response, NextFunction } from 'express';
import { logger } from '../../lib/logger';
import { integrityCheckService } from '../../services/integrity/integrity-check.service';
import type { AuthenticatedRequest } from '../../types/authenticated-request';
import type {
  StartCheckBody,
  GetIssuesQuery,
  IgnoreIssueBody,
  BulkActionBody,
} from '../../schemas/integrity.schemas';

export class IntegrityController {
  /**
   * Start an integrity check
   * POST /api/v1/integrity/check
   */
  async startCheck(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as StartCheckBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await integrityCheckService.startCheck(
        tenantId,
        body.documentId,
        body.checkTypes
      );

      logger.info(`[IntegrityController] Check started: jobId=${result.jobId}, user=${userId}`);

      return res.status(202).json({
        success: true,
        data: {
          jobId: result.jobId,
          status: 'QUEUED',
          message: 'Integrity check started',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get job status
   * GET /api/v1/integrity/job/:jobId
   */
  async getJobStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const job = await integrityCheckService.getJobStatus(jobId, tenantId);

      if (!job) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Integrity check job not found' },
        });
      }

      return res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get issues for a document (filtered, paginated)
   * GET /api/v1/integrity/document/:documentId
   */
  async getIssues(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;
      const query = req.query as unknown as GetIssuesQuery;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await integrityCheckService.getIssues(documentId, tenantId, {
        checkType: query.checkType,
        severity: query.severity,
        status: query.status,
        page: query.page,
        limit: query.limit,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get summary grouped by check type
   * GET /api/v1/integrity/document/:documentId/summary
   */
  async getSummary(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const summary = await integrityCheckService.getSummary(documentId, tenantId);

      return res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Apply a suggested fix to an issue
   * POST /api/v1/integrity/issue/:issueId/fix
   */
  async applyFix(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { issueId } = req.params;
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await integrityCheckService.applyFix(issueId, tenantId, userId);

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Ignore an issue
   * POST /api/v1/integrity/issue/:issueId/ignore
   */
  async ignoreIssue(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { issueId } = req.params;
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;
      const body = (req.body || {}) as IgnoreIssueBody;

      if (!userId || !tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await integrityCheckService.ignoreIssue(issueId, tenantId, userId, body.reason);

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk action on multiple issues
   * POST /api/v1/integrity/issues/bulk
   */
  async bulkAction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as BulkActionBody;
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await integrityCheckService.bulkAction(
        body.issueIds,
        body.action,
        tenantId,
        userId
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const integrityController = new IntegrityController();
