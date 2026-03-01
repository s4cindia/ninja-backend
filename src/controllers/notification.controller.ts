import { Request, Response } from 'express';
import { notificationService } from '../services/notification/notification.service';
import { logger } from '../lib/logger';

class NotificationController {
  async getUnread(req: Request, res: Response): Promise<void> {
    try {
      const { userId, tenantId } = req.user;
      const notifications = await notificationService.getUnreadNotifications(userId, tenantId);
      res.json({ success: true, data: notifications });
    } catch (error) {
      logger.error('Get unread notifications error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to fetch notifications' } });
    }
  }

  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const { userId, tenantId } = req.user;
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const result = await notificationService.getNotifications(userId, tenantId, page, limit);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get all notifications error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to fetch notifications' } });
    }
  }

  async getUnreadCount(req: Request, res: Response): Promise<void> {
    try {
      const { userId, tenantId } = req.user;
      const count = await notificationService.getUnreadCount(userId, tenantId);
      res.json({ success: true, data: { count } });
    } catch (error) {
      logger.error('Get unread count error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to fetch count' } });
    }
  }

  async markAsRead(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.user;
      const { notificationId } = req.params;
      await notificationService.markAsRead(notificationId, userId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Mark as read error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to mark as read' } });
    }
  }

  async markAllAsRead(req: Request, res: Response): Promise<void> {
    try {
      const { userId, tenantId } = req.user;
      await notificationService.markAllAsRead(userId, tenantId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Mark all as read error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to mark all as read' } });
    }
  }

  async deleteNotification(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.user;
      const { notificationId } = req.params;
      await notificationService.deleteNotification(notificationId, userId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Delete notification error:', error);
      res.status(500).json({ success: false, error: { message: 'Failed to delete notification' } });
    }
  }
}

export const notificationController = new NotificationController();
