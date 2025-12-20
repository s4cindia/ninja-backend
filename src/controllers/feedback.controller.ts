import { Request, Response } from 'express';
import { feedbackService } from '../services/feedback/feedback.service';
import { logger } from '../lib/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    tenantId: string;
    role: string;
  };
}

export const feedbackController = {
  async create(req: AuthenticatedRequest, res: Response) {
    try {
      const { type, rating, comment, context, metadata } = req.body;
      const userId = req.user?.id;
      const userEmail = req.user?.email;
      const tenantId = req.user?.tenantId;

      if (!type || !comment) {
        return res.status(400).json({
          success: false,
          error: 'Type and comment are required',
        });
      }

      const validTypes = [
        'accessibility_issue',
        'alt_text_quality',
        'audit_accuracy',
        'remediation_suggestion',
        'general',
        'bug_report',
        'feature_request',
      ];

      if (!validTypes.includes(type)) {
        return res.status(400).json({
          success: false,
          error: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
        });
      }

      if (rating !== undefined && (rating < 1 || rating > 5)) {
        return res.status(400).json({
          success: false,
          error: 'Rating must be between 1 and 5',
        });
      }

      const feedback = await feedbackService.createFeedback({
        type,
        rating,
        comment,
        context,
        userId,
        userEmail,
        tenantId,
        metadata,
      });

      return res.status(201).json({
        success: true,
        data: feedback,
      });
    } catch (error) {
      logger.error('Failed to create feedback', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to create feedback',
      });
    }
  },

  async getById(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      const feedback = await feedbackService.getFeedback(id);

      if (!feedback) {
        return res.status(404).json({
          success: false,
          error: 'Feedback not found',
        });
      }

      return res.json({
        success: true,
        data: feedback,
      });
    } catch (error) {
      logger.error('Failed to get feedback', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get feedback',
      });
    }
  },

  async list(req: AuthenticatedRequest, res: Response) {
    try {
      const {
        type,
        status,
        rating,
        jobId,
        page = '1',
        limit = '20',
      } = req.query;

      const tenantId = req.user?.tenantId;

      const result = await feedbackService.listFeedback(
        {
          type: type as string | undefined,
          status: status as string | undefined,
          rating: rating ? Number(rating) : undefined,
          jobId: jobId as string | undefined,
          tenantId,
        } as Parameters<typeof feedbackService.listFeedback>[0],
        Number(page),
        Number(limit)
      );

      return res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Failed to list feedback', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to list feedback',
      });
    }
  },

  async updateStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { status, response } = req.body;
      const respondedBy = req.user?.id;

      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Status is required',
        });
      }

      const validStatuses = ['new', 'reviewed', 'in_progress', 'resolved', 'dismissed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      const feedback = await feedbackService.updateFeedbackStatus(
        id,
        status,
        response,
        respondedBy
      );

      return res.json({
        success: true,
        data: feedback,
      });
    } catch (error) {
      logger.error('Failed to update feedback', error instanceof Error ? error : undefined);
      const message = error instanceof Error ? error.message : 'Failed to update feedback';
      const statusCode = message === 'Feedback not found' ? 404 : 500;
      return res.status(statusCode).json({
        success: false,
        error: message,
      });
    }
  },

  async quickRating(req: AuthenticatedRequest, res: Response) {
    try {
      const { entityType, entityId, isPositive } = req.body;
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!entityType || !entityId || isPositive === undefined) {
        return res.status(400).json({
          success: false,
          error: 'entityType, entityId, and isPositive are required',
        });
      }

      const validEntityTypes = ['alt_text', 'audit', 'remediation'];
      if (!validEntityTypes.includes(entityType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid entityType. Must be one of: ${validEntityTypes.join(', ')}`,
        });
      }

      const feedback = await feedbackService.submitQuickRating(
        entityType,
        entityId,
        isPositive,
        userId,
        tenantId
      );

      return res.status(201).json({
        success: true,
        data: feedback,
      });
    } catch (error) {
      logger.error('Failed to submit rating', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to submit rating',
      });
    }
  },

  async getJobFeedback(req: AuthenticatedRequest, res: Response) {
    try {
      const { jobId } = req.params;

      const feedback = await feedbackService.getJobFeedback(jobId);

      return res.json({
        success: true,
        data: feedback,
      });
    } catch (error) {
      logger.error('Failed to get job feedback', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to get job feedback',
      });
    }
  },
};
