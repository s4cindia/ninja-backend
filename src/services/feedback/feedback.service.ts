import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import crypto from 'crypto';

type FeedbackType = 
  | 'accessibility_issue'
  | 'alt_text_quality'
  | 'audit_accuracy'
  | 'remediation_suggestion'
  | 'general'
  | 'bug_report'
  | 'feature_request';

type FeedbackRating = 1 | 2 | 3 | 4 | 5;

type FeedbackStatus = 'new' | 'reviewed' | 'in_progress' | 'resolved' | 'dismissed';

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
  rating?: FeedbackRating;
  comment: string;
  context?: FeedbackContext;
  userId?: string;
  userEmail?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

interface Feedback {
  id: string;
  type: FeedbackType;
  rating?: FeedbackRating;
  comment: string;
  context: FeedbackContext;
  userId?: string;
  userEmail?: string;
  tenantId?: string;
  status: FeedbackStatus;
  metadata?: Record<string, unknown>;
  response?: string;
  respondedBy?: string;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface FeedbackFilters {
  type?: FeedbackType;
  status?: FeedbackStatus;
  rating?: FeedbackRating;
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

class FeedbackService {
  async createFeedback(input: CreateFeedbackInput): Promise<Feedback> {
    const id = this.generateId();
    
    const feedback: Feedback = {
      id,
      type: input.type,
      rating: input.rating,
      comment: input.comment,
      context: input.context || {},
      userId: input.userId,
      userEmail: input.userEmail,
      tenantId: input.tenantId,
      status: 'new',
      metadata: input.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await prisma.job.create({
      data: {
        id,
        tenantId: input.tenantId || 'system',
        userId: input.userId || 'anonymous',
        type: 'BATCH_VALIDATION',
        status: 'COMPLETED',
        input: JSON.parse(JSON.stringify({
          feedbackType: input.type,
          context: input.context,
          recordType: 'feedback',
        })),
        output: JSON.parse(JSON.stringify(feedback)),
        completedAt: new Date(),
      },
    });

    logger.info(`Feedback created: ${id} (${input.type})`);
    return feedback;
  }

  async getFeedback(id: string): Promise<Feedback | null> {
    const job = await prisma.job.findFirst({
      where: {
        id,
        type: 'BATCH_VALIDATION',
        input: {
          path: ['recordType'],
          equals: 'feedback',
        },
      },
    });

    if (!job?.output) {
      return null;
    }

    return job.output as unknown as Feedback;
  }

  async listFeedback(
    filters: FeedbackFilters = {},
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResult<Feedback>> {
    const jobs = await prisma.job.findMany({
      where: {
        type: 'BATCH_VALIDATION',
        input: {
          path: ['recordType'],
          equals: 'feedback',
        },
        ...(filters.tenantId && { tenantId: filters.tenantId }),
        ...(filters.userId && { userId: filters.userId }),
      },
      orderBy: { createdAt: 'desc' },
    });

    let items = jobs
      .filter(j => j.output)
      .map(j => j.output as unknown as Feedback);

    if (filters.type) {
      items = items.filter(f => f.type === filters.type);
    }
    if (filters.status) {
      items = items.filter(f => f.status === filters.status);
    }
    if (filters.rating) {
      items = items.filter(f => f.rating === filters.rating);
    }
    if (filters.jobId) {
      items = items.filter(f => f.context.jobId === filters.jobId);
    }
    if (filters.startDate) {
      items = items.filter(f => new Date(f.createdAt) >= filters.startDate!);
    }
    if (filters.endDate) {
      items = items.filter(f => new Date(f.createdAt) <= filters.endDate!);
    }

    const total = items.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    items = items.slice(offset, offset + limit);

    return { items, total, page, totalPages };
  }

  async updateFeedbackStatus(
    id: string,
    status: FeedbackStatus,
    response?: string,
    respondedBy?: string
  ): Promise<Feedback> {
    const feedback = await this.getFeedback(id);
    if (!feedback) {
      throw new Error('Feedback not found');
    }

    feedback.status = status;
    feedback.updatedAt = new Date();

    if (response) {
      feedback.response = response;
      feedback.respondedBy = respondedBy;
      feedback.respondedAt = new Date();
    }

    await prisma.job.update({
      where: { id },
      data: {
        output: JSON.parse(JSON.stringify(feedback)),
      },
    });

    logger.info(`Feedback ${id} status updated to ${status}`);
    return feedback;
  }

  async submitQuickRating(
    entityType: 'alt_text' | 'audit' | 'remediation',
    entityId: string,
    isPositive: boolean,
    userId?: string,
    tenantId?: string
  ): Promise<Feedback> {
    const typeMap: Record<string, FeedbackType> = {
      alt_text: 'alt_text_quality',
      audit: 'audit_accuracy',
      remediation: 'remediation_suggestion',
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

  async getJobFeedback(jobId: string): Promise<Feedback[]> {
    const { items } = await this.listFeedback({ jobId }, 1, 1000);
    return items;
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomBytes(4).toString('hex');
    return `fb-${timestamp}-${randomPart}`;
  }
}

export const feedbackService = new FeedbackService();
export type { Feedback, FeedbackType, FeedbackStatus, FeedbackRating, FeedbackFilters, CreateFeedbackInput };
