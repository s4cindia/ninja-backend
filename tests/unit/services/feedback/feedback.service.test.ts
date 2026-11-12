/**
 * FeedbackService -- UAT defect-logging extension: severity (filtering,
 * stats, requiring-attention ordering) and the status-change notification
 * loop back to the original submitter.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateNotification = vi.fn();
const mockSendFeedbackSubmittedEmail = vi.fn();

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
    user: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/services/notification/notification.service', () => ({
  notificationService: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));

vi.mock('../../../../src/services/email/email.service', () => ({
  emailService: { sendFeedbackSubmittedEmail: (...args: unknown[]) => mockSendFeedbackSubmittedEmail(...args) },
}));

import prisma from '../../../../src/lib/prisma';
import { feedbackService } from '../../../../src/services/feedback/feedback.service';

describe('FeedbackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNotification.mockResolvedValue(undefined);
    mockSendFeedbackSubmittedEmail.mockResolvedValue(undefined);
    (prisma.user.findMany as any).mockResolvedValue([]);
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

    describe('new-feedback admin notifications', () => {
      const createdFeedback = {
        id: 'f-new',
        tenantId: 't-1',
        userId: 'submitter-1',
        userEmail: 'submitter@example.com',
        type: 'BUG_REPORT',
        severity: 'HIGH',
        comment: 'Download button does nothing',
      };

      const admin1 = { id: 'admin-1', email: 'admin1@example.com', firstName: 'Ada', lastName: 'Admin' };
      const admin2 = { id: 'admin-2', email: 'admin2@example.com', firstName: 'Bo', lastName: 'Boss' };

      it('notifies every ADMIN user in the same tenant via both in-app and email', async () => {
        (prisma.feedback.create as any).mockResolvedValue(createdFeedback);
        (prisma.user.findMany as any).mockResolvedValue([admin1, admin2]);

        await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          severity: 'HIGH',
          comment: 'Download button does nothing',
          userId: 'submitter-1',
          userEmail: 'submitter@example.com',
          tenantId: 't-1',
        });

        await vi.waitFor(() => expect(mockCreateNotification).toHaveBeenCalledTimes(2));

        expect(prisma.user.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { tenantId: 't-1', role: 'ADMIN', deletedAt: null },
          })
        );

        expect(mockCreateNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'admin-1',
            tenantId: 't-1',
            type: 'FEEDBACK_SUBMITTED',
            link: '/feedback',
          })
        );
        expect(mockCreateNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'admin-2',
            tenantId: 't-1',
            type: 'FEEDBACK_SUBMITTED',
            link: '/feedback',
          })
        );

        await vi.waitFor(() => expect(mockSendFeedbackSubmittedEmail).toHaveBeenCalledTimes(2));
        expect(mockSendFeedbackSubmittedEmail).toHaveBeenCalledWith(
          expect.objectContaining({ adminEmail: 'admin1@example.com' })
        );
        expect(mockSendFeedbackSubmittedEmail).toHaveBeenCalledWith(
          expect.objectContaining({ adminEmail: 'admin2@example.com' })
        );
      });

      it('does not notify ADMIN users belonging to a different tenant', async () => {
        (prisma.feedback.create as any).mockResolvedValue({ ...createdFeedback, tenantId: 't-1' });
        (prisma.user.findMany as any).mockResolvedValue([]);

        await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          comment: 'Download button does nothing',
          tenantId: 't-1',
        });

        await vi.waitFor(() =>
          expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tenantId: 't-1' }) })
          )
        );

        // The query is always scoped to the submitting tenant -- an admin
        // seeded under a different tenant (e.g. 't-2') would never be
        // returned by this where clause, so no notification is sent.
        expect(mockCreateNotification).not.toHaveBeenCalled();
        expect(mockSendFeedbackSubmittedEmail).not.toHaveBeenCalled();
      });

      it('is a no-op when the tenant has zero ADMIN users', async () => {
        (prisma.feedback.create as any).mockResolvedValue(createdFeedback);
        (prisma.user.findMany as any).mockResolvedValue([]);

        const result = await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          comment: 'Download button does nothing',
          tenantId: 't-1',
        });

        expect(result).toEqual(createdFeedback);
        expect(mockCreateNotification).not.toHaveBeenCalled();
        expect(mockSendFeedbackSubmittedEmail).not.toHaveBeenCalled();
      });

      it('still resolves createFeedback even if admin lookup rejects', async () => {
        (prisma.feedback.create as any).mockResolvedValue(createdFeedback);
        (prisma.user.findMany as any).mockRejectedValue(new Error('db down'));

        const result = await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          comment: 'Download button does nothing',
          tenantId: 't-1',
        });

        expect(result).toEqual(createdFeedback);
      });

      it('still resolves createFeedback even if the in-app notification rejects', async () => {
        (prisma.feedback.create as any).mockResolvedValue(createdFeedback);
        (prisma.user.findMany as any).mockResolvedValue([admin1]);
        mockCreateNotification.mockRejectedValue(new Error('notification service down'));

        const result = await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          comment: 'Download button does nothing',
          tenantId: 't-1',
        });

        expect(result).toEqual(createdFeedback);
        await vi.waitFor(() => expect(mockCreateNotification).toHaveBeenCalledTimes(1));
      });

      it('still resolves createFeedback even if the email send rejects', async () => {
        (prisma.feedback.create as any).mockResolvedValue(createdFeedback);
        (prisma.user.findMany as any).mockResolvedValue([admin1]);
        mockSendFeedbackSubmittedEmail.mockRejectedValue(new Error('smtp down'));

        const result = await feedbackService.createFeedback({
          type: 'BUG_REPORT',
          comment: 'Download button does nothing',
          tenantId: 't-1',
        });

        expect(result).toEqual(createdFeedback);
        await vi.waitFor(() => expect(mockSendFeedbackSubmittedEmail).toHaveBeenCalledTimes(1));
      });
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
