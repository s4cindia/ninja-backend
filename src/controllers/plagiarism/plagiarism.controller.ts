/**
 * Plagiarism Check Controller
 *
 * Handles plagiarism check API requests:
 * - Start plagiarism check jobs
 * - Get job status
 * - Get matches (filtered, paginated)
 * - Get summary
 * - Review match / bulk review
 */

import { Response, NextFunction } from 'express';
import { logger } from '../../lib/logger';
import { plagiarismCheckService } from '../../services/plagiarism/plagiarism-check.service';
import type { AuthenticatedRequest } from '../../types/authenticated-request';
import type {
  StartPlagiarismCheckBody,
  GetMatchesQuery,
  ReviewMatchBody,
  BulkReviewBody,
} from '../../schemas/plagiarism.schemas';

export class PlagiarismController {
  /**
   * Start a plagiarism check
   * POST /api/v1/plagiarism/check
   */
  async startCheck(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as StartPlagiarismCheckBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await plagiarismCheckService.startCheck(tenantId, body.documentId);

      logger.info(`[PlagiarismController] Check started: jobId=${result.jobId}, user=${userId}`);

      return res.status(202).json({
        success: true,
        data: {
          jobId: result.jobId,
          status: 'QUEUED',
          message: 'Plagiarism check started',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get job status
   * GET /api/v1/plagiarism/job/:jobId
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

      const job = await plagiarismCheckService.getJobStatus(jobId, tenantId);

      if (!job) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Plagiarism check job not found' },
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
   * Get matches for a document (filtered, paginated)
   * GET /api/v1/plagiarism/document/:documentId
   */
  async getMatches(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;
      const query = req.query as unknown as GetMatchesQuery;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await plagiarismCheckService.getMatches(documentId, tenantId, {
        matchType: query.matchType,
        classification: query.classification,
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
   * Get summary grouped by type/classification/status
   * GET /api/v1/plagiarism/document/:documentId/summary
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

      const summary = await plagiarismCheckService.getSummary(documentId, tenantId);

      return res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Review a single match
   * POST /api/v1/plagiarism/match/:matchId/review
   */
  async reviewMatch(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { matchId } = req.params;
      const body = req.body as ReviewMatchBody;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await plagiarismCheckService.reviewMatch(
        matchId,
        tenantId,
        body.status,
        userId,
        body.reviewNotes
      );

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk review multiple matches
   * POST /api/v1/plagiarism/matches/bulk
   */
  async bulkReview(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as BulkReviewBody;
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await plagiarismCheckService.bulkReview(
        body.matchIds,
        tenantId,
        body.status,
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

export const plagiarismController = new PlagiarismController();
