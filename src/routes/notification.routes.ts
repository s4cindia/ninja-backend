import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { notificationController } from '../controllers/notification.controller';

const router = Router();

// Static routes before parameterized routes
router.get('/unread', authenticate, (req, res) => notificationController.getUnread(req, res));
router.get('/count', authenticate, (req, res) => notificationController.getUnreadCount(req, res));
router.get('/', authenticate, (req, res) => notificationController.getAll(req, res));
router.post('/mark-all-read', authenticate, (req, res) => notificationController.markAllAsRead(req, res));
router.patch('/:notificationId/read', authenticate, (req, res) => notificationController.markAsRead(req, res));
router.delete('/:notificationId', authenticate, (req, res) => notificationController.deleteNotification(req, res));

export default router;
