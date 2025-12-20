import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { FeedbackType, FeedbackStatus, Feedback as PrismaFeedback } from '@prisma/client';

interface FeedbackContext {
  jobId?: string;
  imageId?: string;
  altTextId?: string;
  issueId?: string;
  pageNumber?: number;
  elementPath?: string;
  url?: string;
}

interface CreateFeedbackInput {
  type: FeedbackType;
  rating?: number;
  comment: string;
  context?: FeedbackContext;
  userId?: string;
  userEmail?: string;
  tenantId: string;
  metadata?: Record<string, unknown>;
}

interface FeedbackFilters {
  type?: FeedbackType;
  status?: FeedbackStatus;
  rating?: number;
  jobId?: string;
  userId?: string;
  tenantId?: string;
  startDate?: Date;
  endDate?: Date;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  totalPages: number;
}

const TYPE_MAP: Record<string, FeedbackType> = {
  accessibility_issue: 'ACCESSIBILITY_ISSUE',
  alt_text_quality: 'ALT_TEXT_QUALITY',
  audit_accuracy: 'AUDIT_ACCURACY',
  remediation_suggestion: 'REMEDIATION_SUGGESTION',
  general: 'GENERAL',
  bug_report: 'BUG_REPORT',
  feature_request: 'FEATURE_REQUEST',
};

const STATUS_MAP: Record<string, FeedbackStatus> = {
  new: 'NEW',
  reviewed: 'REVIEWED',
  in_progress: 'IN_PROGRESS',
  resolved: 'RESOLVED',
  dismissed: 'DISMISSED',
};

class FeedbackService {
  async createFeedback(input: CreateFeedbackInput): Promise<PrismaFeedback> {
    const feedback = await prisma.feedback.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        userEmail: input.userEmail,
        type: input.type,
        rating: input.rating,
        comment: input.comment,
        context: input.context ? JSON.parse(JSON.stringify(input.context)) : undefined,
        metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
        status: 'NEW',
      },
    });

    logger.info(`Feedback created: ${feedback.id} (${feedback.type})`);
    return feedback;
  }

  async getFeedback(id: string): Promise<PrismaFeedback | null> {
    return prisma.feedback.findUnique({
      where: { id },
    });
  }

  async listFeedback(
    filters: FeedbackFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResult<PrismaFeedback>> {
    const where: Record<string, unknown> = {};

    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.type) where.type = filters.type;
    if (filters.status) where.status = filters.status;
    if (filters.rating) where.rating = filters.rating;
    
    if (filters.jobId) {
      where.context = {
        path: ['jobId'],
        equals: filters.jobId,
      };
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        (where.createdAt as Record<string, Date>).gte = filters.startDate;
      }
      if (filters.endDate) {
        (where.createdAt as Record<string, Date>).lte = filters.endDate;
      }
    }

    const [items, total] = await Promise.all([
      prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.feedback.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateFeedbackStatus(
    id: string,
    status: FeedbackStatus,
    response?: string,
    respondedBy?: string
  ): Promise<PrismaFeedback> {
    const feedback = await prisma.feedback.findUnique({
      where: { id },
    });

    if (!feedback) {
      throw new Error('Feedback not found');
    }

    const updateData: Record<string, unknown> = {
      status,
    };

    if (response) {
      updateData.response = response;
      updateData.respondedBy = respondedBy;
      updateData.respondedAt = new Date();
    }

    const updated = await prisma.feedback.update({
      where: { id },
      data: updateData,
    });

    logger.info(`Feedback ${id} status updated to ${status}`);
    return updated;
  }

  async submitQuickRating(
    entityType: 'alt_text' | 'audit' | 'remediation',
    entityId: string,
    isPositive: boolean,
    userId?: string,
    tenantId?: string
  ): Promise<PrismaFeedback> {
    const typeMap: Record<string, FeedbackType> = {
      alt_text: 'ALT_TEXT_QUALITY',
      audit: 'AUDIT_ACCURACY',
      remediation: 'REMEDIATION_SUGGESTION',
    };

    return this.createFeedback({
      type: typeMap[entityType],
      rating: isPositive ? 5 : 1,
      comment: isPositive ? 'Helpful' : 'Not helpful',
      context: {
        altTextId: entityType === 'alt_text' ? entityId : undefined,
        issueId: entityType === 'audit' || entityType === 'remediation' ? entityId : undefined,
      },
      userId,
      tenantId: tenantId || 'system',
    });
  }

  async getJobFeedback(jobId: string): Promise<PrismaFeedback[]> {
    return prisma.feedback.findMany({
      where: {
        context: {
          path: ['jobId'],
          equals: jobId,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static toFeedbackType(type: string): FeedbackType {
    const mapped = TYPE_MAP[type.toLowerCase()];
    if (!mapped) {
      throw new Error(`Invalid feedback type: ${type}`);
    }
    return mapped;
  }

  static toFeedbackStatus(status: string): FeedbackStatus {
    const mapped = STATUS_MAP[status.toLowerCase()];
    if (!mapped) {
      throw new Error(`Invalid feedback status: ${status}`);
    }
    return mapped;
  }
}

export const feedbackService = new FeedbackService();
export { FeedbackService };
export type { PrismaFeedback as Feedback, FeedbackFilters, CreateFeedbackInput };
