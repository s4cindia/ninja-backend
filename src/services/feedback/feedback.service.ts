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

interface FeedbackStats {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRating: Record<string, number>;
  averageRating: number;
  recentCount: number;
  responseRate: number;
  averageResponseTimeHours: number | null;
}

interface FeedbackTrend {
  date: string;
  count: number;
  averageRating: number;
}

interface TopIssue {
  type: string;
  count: number;
  averageRating: number;
  unresolvedCount: number;
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

  async getStats(tenantId?: string): Promise<FeedbackStats> {
    const where = tenantId ? { tenantId } : {};

    const allFeedback = await prisma.feedback.findMany({ where });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byRating: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    
    let ratingSum = 0;
    let ratingCount = 0;
    let recentCount = 0;
    let respondedCount = 0;
    let totalResponseTimeMs = 0;
    let responseTimeCount = 0;

    for (const feedback of allFeedback) {
      byType[feedback.type] = (byType[feedback.type] || 0) + 1;
      byStatus[feedback.status] = (byStatus[feedback.status] || 0) + 1;

      if (feedback.rating) {
        byRating[String(feedback.rating)] = (byRating[String(feedback.rating)] || 0) + 1;
        ratingSum += feedback.rating;
        ratingCount++;
      }

      if (feedback.createdAt >= sevenDaysAgo) {
        recentCount++;
      }

      if (feedback.respondedAt) {
        respondedCount++;
        const responseTime = feedback.respondedAt.getTime() - feedback.createdAt.getTime();
        totalResponseTimeMs += responseTime;
        responseTimeCount++;
      }
    }

    const total = allFeedback.length;
    const responseRate = total > 0 ? Math.round((respondedCount / total) * 100) : 0;
    const averageResponseTimeHours = responseTimeCount > 0
      ? Math.round((totalResponseTimeMs / responseTimeCount) / (1000 * 60 * 60) * 10) / 10
      : null;

    return {
      total,
      byType,
      byStatus,
      byRating,
      averageRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
      recentCount,
      responseRate,
      averageResponseTimeHours,
    };
  }

  async getTrends(tenantId?: string, days: number = 30): Promise<FeedbackTrend[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const where: Record<string, unknown> = {
      createdAt: { gte: startDate },
    };
    if (tenantId) where.tenantId = tenantId;

    const feedback = await prisma.feedback.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    const trendMap: Record<string, { count: number; ratingSum: number; ratingCount: number }> = {};

    for (const fb of feedback) {
      const dateKey = fb.createdAt.toISOString().split('T')[0];
      
      if (!trendMap[dateKey]) {
        trendMap[dateKey] = { count: 0, ratingSum: 0, ratingCount: 0 };
      }
      
      trendMap[dateKey].count++;
      if (fb.rating) {
        trendMap[dateKey].ratingSum += fb.rating;
        trendMap[dateKey].ratingCount++;
      }
    }

    const trends: FeedbackTrend[] = [];
    const currentDate = new Date(startDate);
    const endDate = new Date();

    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const data = trendMap[dateKey];

      trends.push({
        date: dateKey,
        count: data?.count || 0,
        averageRating: data?.ratingCount
          ? Math.round((data.ratingSum / data.ratingCount) * 10) / 10
          : 0,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return trends;
  }

  async getTopIssues(tenantId?: string, limit: number = 10): Promise<TopIssue[]> {
    const where = tenantId ? { tenantId } : {};

    const feedback = await prisma.feedback.findMany({ where });

    const issueMap: Record<string, {
      count: number;
      ratingSum: number;
      ratingCount: number;
      unresolvedCount: number;
    }> = {};

    for (const fb of feedback) {
      const key = fb.type;
      
      if (!issueMap[key]) {
        issueMap[key] = { count: 0, ratingSum: 0, ratingCount: 0, unresolvedCount: 0 };
      }

      issueMap[key].count++;
      
      if (fb.rating) {
        issueMap[key].ratingSum += fb.rating;
        issueMap[key].ratingCount++;
      }

      if (fb.status !== 'RESOLVED' && fb.status !== 'DISMISSED') {
        issueMap[key].unresolvedCount++;
      }
    }

    const topIssues: TopIssue[] = Object.entries(issueMap)
      .map(([type, data]) => ({
        type,
        count: data.count,
        averageRating: data.ratingCount
          ? Math.round((data.ratingSum / data.ratingCount) * 10) / 10
          : 0,
        unresolvedCount: data.unresolvedCount,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return topIssues;
  }

  async getRequiringAttention(tenantId?: string, limit: number = 10): Promise<PrismaFeedback[]> {
    const where: Record<string, unknown> = {
      status: { in: ['NEW', 'REVIEWED'] },
    };
    if (tenantId) where.tenantId = tenantId;

    return prisma.feedback.findMany({
      where,
      orderBy: [
        { rating: 'asc' },
        { createdAt: 'asc' },
      ],
      take: limit,
    });
  }
}

export const feedbackService = new FeedbackService();
export { FeedbackService };
export type { PrismaFeedback as Feedback, FeedbackFilters, CreateFeedbackInput };
