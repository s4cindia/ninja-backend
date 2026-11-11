/**
 * FeedbackService -- UAT defect-logging extension: severity (filtering,
 * stats, requiring-attention ordering) and the status-change notification
 * loop back to the original submitter.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateNotification = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    feedback: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/services/notification/notification.service', () => ({
  notificationService: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));

import prisma from '../../../../src/lib/prisma';
import { feedbackService } from '../../../../src/services/feedback/feedback.service';

describe('FeedbackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNotification.mockResolvedValue(undefined);
  });

  describe('createFeedback', () => {
    it('persists severity alongside the other fields', async () => {
      (prisma.feedback.create as any).mockResolvedValue({ id: 'f-1' });

      await feedbackService.createFeedback({
        type: 'BUG_REPORT',
        severity: 'CRITICAL',
        comment: 'Download button does nothing',
        tenantId: 't-1',
      });

      expect(prisma.feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ severity: 'CRITICAL' }) })
      );
    });

    it('leaves severity undefined when not provided (not every feedback type needs one)', async () => {
      (prisma.feedback.create as any).mockResolvedValue({ id: 'f-2' });

      await feedbackService.createFeedback({
        type: 'FEATURE_REQUEST',
        comment: 'Would like batch export',
        tenantId: 't-1',
      });

      expect(prisma.feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ severity: undefined }) })
      );
    });
  });

  describe('listFeedback', () => {
    it('applies a severity filter when provided', async () => {
      (prisma.feedback.findMany as any).mockResolvedValue([]);
      (prisma.feedback.count as any).mockResolvedValue(0);

      await feedbackService.listFeedback({ tenantId: 't-1', severity: 'HIGH' });

      const where = (prisma.feedback.findMany as any).mock.calls[0][0].where;
      expect(where.severity).toBe('HIGH');
    });

    it('omits the severity filter entirely when not provided', async () => {
      (prisma.feedback.findMany as any).mockResolvedValue([]);
      (prisma.feedback.count as any).mockResolvedValue(0);

      await feedbackService.listFeedback({ tenantId: 't-1' });

      const where = (prisma.feedback.findMany as any).mock.calls[0][0].where;
      expect(where.severity).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('includes a bySeverity breakdown, excluding rows with no severity set', async () => {
      (prisma.feedback.count as any).mockResolvedValue(10);
      (prisma.feedback.groupBy as any)
        .mockResolvedValueOnce([{ type: 'BUG_REPORT', _count: 10 }]) // typeCounts
        .mockResolvedValueOnce([{ status: 'NEW', _count: 10 }]) // statusCounts
        .mockResolvedValueOnce([{ severity: 'CRITICAL', _count: 3 }, { severity: 'LOW', _count: 2 }]) // severityCounts
        .mockResolvedValueOnce([]); // ratingDistribution
      (prisma.feedback.aggregate as any)
        .mockResolvedValueOnce({ _avg: { rating: null }, _count: { rating: 0 } }) // ratingStats
        .mockResolvedValueOnce({ _count: 0 }); // responseMetrics

      const stats = await feedbackService.getStats('t-1');

      expect(stats.bySeverity).toEqual({ CRITICAL: 3, LOW: 2 });
      // The severity groupBy's own where clause must exclude null severity.
      const severityCall = (prisma.feedback.groupBy as any).mock.calls[2][0];
      expect(severityCall.where.severity).toEqual({ not: null });
    });
  });

  describe('getRequiringAttention', () => {
    it('orders by severity first, then rating, then recency', async () => {
      (prisma.feedback.findMany as any).mockResolvedValue([]);

      await feedbackService.getRequiringAttention('t-1');

      const orderBy = (prisma.feedback.findMany as any).mock.calls[0][0].orderBy;
      expect(orderBy).toEqual([
        { severity: 'asc' },
        { rating: 'asc' },
        { createdAt: 'asc' },
      ]);
    });
  });

  describe('updateFeedbackStatus', () => {
    const baseRow = {
      id: 'f-1',
      tenantId: 't-1',
      userId: 'submitter-1',
      type: 'BUG_REPORT',
      status: 'RESOLVED',
    };

    it('includes severity in the update when provided', async () => {
      (prisma.feedback.updateMany as any).mockResolvedValue({ count: 1 });
      (prisma.feedback.findUnique as any).mockResolvedValue(baseRow);

      await feedbackService.updateFeedbackStatus('f-1', 't-1', 'RESOLVED', undefined, undefined, 'HIGH');

      expect(prisma.feedback.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ severity: 'HIGH' }) })
      );
    });

    it('notifies the original submitter when the status changes', async () => {
      (prisma.feedback.updateMany as any).mockResolvedValue({ count: 1 });
      (prisma.feedback.findUnique as any).mockResolvedValue(baseRow);

      await feedbackService.updateFeedbackStatus('f-1', 't-1', 'RESOLVED');

      await vi.waitFor(() => expect(mockCreateNotification).toHaveBeenCalledTimes(1));
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'submitter-1',
          tenantId: 't-1',
          type: 'FEEDBACK_STATUS_CHANGED',
          link: '/feedback',
        })
      );
    });

    it('does not notify for anonymous feedback (no userId)', async () => {
      (prisma.feedback.updateMany as any).mockResolvedValue({ count: 1 });
      (prisma.feedback.findUnique as any).mockResolvedValue({ ...baseRow, userId: null });

      await feedbackService.updateFeedbackStatus('f-1', 't-1', 'RESOLVED');

      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('still returns the updated feedback even if the notification call fails', async () => {
      (prisma.feedback.updateMany as any).mockResolvedValue({ count: 1 });
      (prisma.feedback.findUnique as any).mockResolvedValue(baseRow);
      mockCreateNotification.mockRejectedValue(new Error('notification service down'));

      const result = await feedbackService.updateFeedbackStatus('f-1', 't-1', 'RESOLVED');

      expect(result).toEqual(baseRow);
    });
  });
});
