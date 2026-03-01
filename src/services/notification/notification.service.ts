import { NotificationType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

interface CreateNotificationData {
  userId: string;
  tenantId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  link?: string;
}

interface NotificationPage {
  notifications: Awaited<ReturnType<typeof prisma.notification.findMany>>;
  total: number;
  page: number;
  pages: number;
}

class NotificationService {
  async createNotification(data: CreateNotificationData): Promise<void> {
    await prisma.notification.create({
      data: {
        userId: data.userId,
        tenantId: data.tenantId,
        type: data.type,
        title: data.title,
        message: data.message,
        data: data.data ?? {},
        link: data.link,
        read: false,
      },
    });
    logger.info(`[Notification] Created ${data.type} for user ${data.userId}`);
  }

  async getUnreadNotifications(userId: string, tenantId: string) {
    return prisma.notification.findMany({
      where: { userId, tenantId, read: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getNotifications(
    userId: string,
    tenantId: string,
    page = 1,
    limit = 20
  ): Promise<NotificationPage> {
    const skip = (page - 1) * limit;
    const where = { userId, tenantId };

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.notification.count({ where }),
    ]);

    return { notifications, total, page, pages: Math.ceil(total / limit) };
  }

  async getUnreadCount(userId: string, tenantId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, tenantId, read: false } });
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    await prisma.notification.update({
      where: { id: notificationId, userId },
      data: { read: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string, tenantId: string): Promise<void> {
    await prisma.notification.updateMany({
      where: { userId, tenantId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }

  async deleteNotification(notificationId: string, userId: string): Promise<void> {
    await prisma.notification.delete({ where: { id: notificationId, userId } });
  }

  async createBatchCompletionNotification(
    batch: { id: string; name: string; filesRemediated: number; totalIssuesFound: number },
    userId: string,
    tenantId: string
  ): Promise<void> {
    await this.createNotification({
      userId,
      tenantId,
      type: 'BATCH_COMPLETED',
      title: 'Batch Processing Complete',
      message: `Your batch "${batch.name}" completed successfully. ${batch.filesRemediated} file(s) processed.`,
      data: {
        batchId: batch.id,
        batchName: batch.name,
        filesProcessed: batch.filesRemediated,
        totalIssues: batch.totalIssuesFound,
      },
      link: `/batch/${batch.id}/results`,
    });
  }

  async createBatchFailureNotification(
    batch: { id: string; name: string },
    userId: string,
    tenantId: string,
    errorMessage: string
  ): Promise<void> {
    await this.createNotification({
      userId,
      tenantId,
      type: 'BATCH_FAILED',
      title: 'Batch Processing Failed',
      message: `Your batch "${batch.name}" encountered an error: ${errorMessage}`,
      data: { batchId: batch.id, batchName: batch.name, error: errorMessage },
      link: `/batch/${batch.id}`,
    });
  }
}

export const notificationService = new NotificationService();
