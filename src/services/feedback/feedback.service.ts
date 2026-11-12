import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { notificationService } from '../notification/notification.service';
import { emailService } from '../email/email.service';
import { FeedbackType, FeedbackStatus, FeedbackSeverity, Feedback as PrismaFeedback } from '@prisma/client';

type FeedbackWithUser = PrismaFeedback & {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  attachments?: Array<{
    id: string;
    feedbackId: string;
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    uploadedById: string | null;
    createdAt: Date;
    uploadedBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
  }>;
};

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
  severity?: FeedbackSeverity;
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
  severity?: FeedbackSeverity;
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
  bySeverity: Record<string, number>;
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

const SEVERITY_MAP: Record<string, FeedbackSeverity> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

class FeedbackService {
  async createFeedback(input: CreateFeedbackInput): Promise<PrismaFeedback> {
    const feedback = await prisma.feedback.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        userEmail: input.userEmail,
        type: input.type,
        severity: input.severity,
        rating: input.rating,
        comment: input.comment,
        context: input.context ? JSON.parse(JSON.stringify(input.context)) : undefined,
        metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
        status: FeedbackStatus.NEW,
      },
    });

    logger.info(`Feedback created: ${feedback.id} (${feedback.type})`);

    // Notifies every ADMIN in the submitting tenant that new feedback was
    // filed, so UAT bug reports/issues actually get seen instead of relying
    // on someone remembering to check the dashboard. Same "nice-to-have,
    // never the critical path" contract as every other fire-and-forget
    // notification in this file (see updateFeedbackStatus below): a failure
    // here must never fail feedback submission itself. Zero ADMIN users in
    // the tenant is a normal no-op, not an error.
    this.notifyAdminsOfNewFeedback(feedback).catch((notifyErr) => {
      logger.error(
        `[Feedback] Failed to notify admins of new feedback ${feedback.id}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
      );
    });

    return feedback;
  }

  private async notifyAdminsOfNewFeedback(feedback: PrismaFeedback): Promise<void> {
    const admins = await prisma.user.findMany({
      where: { tenantId: feedback.tenantId, role: 'ADMIN', deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (admins.length === 0) {
      return;
    }

    const typeLabel = feedback.type.replace(/_/g, ' ').toLowerCase();
    const commentPreview = feedback.comment.length > 160
      ? `${feedback.comment.slice(0, 160)}...`
      : feedback.comment;

    for (const admin of admins) {
      // In-app and email are independently fire-and-forget -- one admin's
      // failed email must never block another admin's notification, and
      // neither channel is allowed to fail feedback submission itself.
      notificationService
        .createNotification({
          userId: admin.id,
          tenantId: feedback.tenantId,
          type: 'FEEDBACK_SUBMITTED',
          title: 'New feedback submitted',
          message: `A new "${typeLabel}" feedback was submitted: ${commentPreview}`,
          data: { feedbackId: feedback.id },
          link: '/feedback',
        })
        .catch((notifyErr) => {
          logger.error(
            `[Feedback] Failed to create new-feedback notification for admin ${admin.id} (feedback ${feedback.id}): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
          );
        });

      emailService
        .sendFeedbackSubmittedEmail({
          adminName: `${admin.firstName} ${admin.lastName}`.trim(),
          adminEmail: admin.email,
          feedbackType: typeLabel,
          severity: feedback.severity ?? undefined,
          commentPreview,
          submitterEmail: feedback.userEmail ?? undefined,
          feedbackUrl: `${process.env.APP_URL || ''}/feedback`,
        })
        .catch((emailErr) => {
          logger.error(
            `[Feedback] Failed to send new-feedback email to admin ${admin.id} (feedback ${feedback.id}): ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`
          );
        });
    }
  }

  async getFeedback(id: string, tenantId?: string): Promise<FeedbackWithUser | null> {
    const feedback = await prisma.feedback.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        attachments: {
          include: {
            uploadedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    
    if (feedback && tenantId && feedback.tenantId !== tenantId) {
      return null;
    }
    
    return feedback;
  }

  async listFeedback(
    filters: FeedbackFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResult<FeedbackWithUser>> {
    page = Math.max(1, Math.floor(page));
    limit = Math.max(1, Math.min(Math.floor(limit), 100));

    const where: Record<string, unknown> = {};

    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.type) where.type = filters.type;
    if (filters.status) where.status = filters.status;
    if (filters.severity) where.severity = filters.severity;
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
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          attachments: {
            include: {
              uploadedBy: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
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
    tenantId: string,
    status: FeedbackStatus,
    response?: string,
    respondedBy?: string,
    severity?: FeedbackSeverity
  ): Promise<PrismaFeedback> {
    try {
      const result = await prisma.feedback.updateMany({
        where: {
          id,
          tenantId,
        },
        data: {
          status,
          ...(severity !== undefined && { severity }),
          ...(response && {
            response,
            respondedBy,
            respondedAt: new Date(),
          }),
        },
      });

      if (result.count === 0) {
        throw new Error('Feedback not found or unauthorized');
      }

      const updated = await prisma.feedback.findUnique({
        where: { id },
      });

      if (!updated) {
        throw new Error('Feedback not found');
      }

      logger.info(`Feedback ${id} status updated to ${status}`);

      // Closes the loop back to whoever filed it -- same pattern as the
      // TeamReview notification loop. Skipped for anonymous submissions
      // (no userId to notify) and never allowed to fail the status update
      // itself, same "nice-to-have, never the critical path" contract as
      // every other fire-and-forget notification in this codebase.
      if (updated.userId) {
        notificationService
          .createNotification({
            userId: updated.userId,
            tenantId: updated.tenantId,
            type: 'FEEDBACK_STATUS_CHANGED',
            title: 'Your feedback was updated',
            message: response
              ? `Your "${updated.type.replace(/_/g, ' ').toLowerCase()}" feedback is now ${status.replace(/_/g, ' ').toLowerCase()}: ${response}`
              : `Your "${updated.type.replace(/_/g, ' ').toLowerCase()}" feedback is now ${status.replace(/_/g, ' ').toLowerCase()}.`,
            data: { feedbackId: updated.id },
            link: '/feedback',
          })
          .catch((notifyErr) => {
            logger.error(
              `[Feedback] Failed to create status-change notification for ${id}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
            );
          });
      }

      return updated;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new Error('Feedback not found');
      }
      throw error;
    }
  }

  async submitQuickRating(
    entityType: 'alt_text' | 'audit' | 'remediation',
    entityId: string,
    isPositive: boolean,
    userId?: string,
    tenantId?: string
  ): Promise<PrismaFeedback> {
    const VALID_ENTITY_TYPES = ['alt_text', 'audit', 'remediation'] as const;
    
    if (!VALID_ENTITY_TYPES.includes(entityType)) {
      throw new Error(`Invalid entity type: ${entityType}`);
    }

    if (!tenantId) {
      throw new Error('tenantId is required for quick rating');
    }

    const typeMap: Record<string, FeedbackType> = {
      alt_text: FeedbackType.ALT_TEXT_QUALITY,
      audit: FeedbackType.AUDIT_ACCURACY,
      remediation: FeedbackType.REMEDIATION_SUGGESTION,
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
      tenantId,
    });
  }

  async getJobFeedback(jobId: string, tenantId?: string): Promise<PrismaFeedback[]> {
    const where: Record<string, unknown> = {
      context: {
        path: ['jobId'],
        equals: jobId,
      },
    };
    
    if (tenantId) {
      where.tenantId = tenantId;
    }
    
    return prisma.feedback.findMany({
      where,
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

  static toFeedbackSeverity(severity: string): FeedbackSeverity {
    const mapped = SEVERITY_MAP[severity.toLowerCase()];
    if (!mapped) {
      throw new Error(`Invalid feedback severity: ${severity}`);
    }
    return mapped;
  }

  async getStats(tenantId?: string): Promise<FeedbackStats> {
    const where = tenantId ? { tenantId } : {};

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      total,
      typeCounts,
      statusCounts,
      severityCounts,
      ratingStats,
      recentCount,
      responseMetrics,
    ] = await Promise.all([
      prisma.feedback.count({ where }),
      prisma.feedback.groupBy({
        by: ['type'],
        where,
        _count: true,
      }),
      prisma.feedback.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),
      prisma.feedback.groupBy({
        by: ['severity'],
        where: { ...where, severity: { not: null } },
        _count: true,
      }),
      prisma.feedback.aggregate({
        where: { ...where, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prisma.feedback.count({
        where: { ...where, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.feedback.aggregate({
        where: { ...where, respondedAt: { not: null } },
        _count: true,
      }),
    ]);

    const ratingDistribution = await prisma.feedback.groupBy({
      by: ['rating'],
      where: { ...where, rating: { not: null } },
      _count: true,
    });

    const byType: Record<string, number> = {};
    for (const item of typeCounts) {
      byType[item.type] = item._count;
    }

    const byStatus: Record<string, number> = {};
    for (const item of statusCounts) {
      byStatus[item.status] = item._count;
    }

    const bySeverity: Record<string, number> = {};
    for (const item of severityCounts) {
      if (item.severity) bySeverity[item.severity] = item._count;
    }

    const byRating: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    for (const item of ratingDistribution) {
      if (item.rating) {
        byRating[String(item.rating)] = item._count;
      }
    }

    const responseRate = total > 0 
      ? Math.round((responseMetrics._count / total) * 100) 
      : 0;

    return {
      total,
      byType,
      byStatus,
      bySeverity,
      byRating,
      averageRating: ratingStats._avg.rating 
        ? Math.round(ratingStats._avg.rating * 10) / 10 
        : 0,
      recentCount,
      responseRate,
      averageResponseTimeHours: null,
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
      // severity's declaration order (CRITICAL..LOW) IS the priority
      // order -- nulls (no severity set) sort last by Postgres's own
      // default for ASC, which is exactly "unprioritized goes last" here.
      orderBy: [
        { severity: 'asc' },
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
