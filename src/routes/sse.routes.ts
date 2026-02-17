import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { sseService } from '../sse/sse.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

const router = Router();

router.get('/subscribe', async (req: Request, res: Response) => {
  const channel = req.query.channel as string;
  const token = (req.query.token as string) || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, error: { message: 'No token provided' } });
    return;
  }

  if (!channel) {
    res.status(400).json({ success: false, error: { message: 'Channel is required' } });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      res.status(500).json({ success: false, error: { message: 'Server configuration error' } });
      return;
    }

    const decoded = jwt.verify(token, jwtSecret) as {
      userId: string;
      tenantId: string;
      sub?: string;
    };

    const userId = decoded.userId || decoded.sub;
    const tenantId = decoded.tenantId;

    if (!userId || !tenantId) {
      res.status(401).json({ success: false, error: { message: 'Invalid token payload' } });
      return;
    }

    logger.info(`[SSE] Client subscribing to channel ${channel}, user ${userId}`);

    const clientId = sseService.addClient(res, tenantId);
    sseService.subscribeToChannel(clientId, channel);
    sseService.sendToClient(clientId, { type: 'subscribed', channel });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ success: false, error: { message: 'Invalid token' } });
      return;
    }
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: { message: 'Token expired' } });
      return;
    }
    logger.error(`[SSE] Authentication error: ${err}`);
    res.status(401).json({ success: false, error: { message: 'Authentication failed' } });
  }
});

router.get('/batch/:batchId/progress', async (req: Request, res: Response) => {
  const { batchId } = req.params;

  // Accept token from query param (for EventSource) or header (for curl/testing)
  const token = (req.query.token as string) || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ success: false, error: 'No token provided' });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
    if (!jwtSecret) {
      logger.error('JWT_SECRET not configured');
      res.status(500).json({ success: false, error: 'Server configuration error' });
      return;
    }

    const decoded = jwt.verify(token, jwtSecret) as {
      userId: string;
      tenantId: string;
      sub?: string;
    };

    const userId = decoded.userId || decoded.sub;
    const tenantId = decoded.tenantId;

    if (!userId || !tenantId) {
      res.status(401).json({ success: false, error: 'Invalid token payload' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, deletedAt: true }
    });

    if (!user) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    if (user.deletedAt) {
      res.status(401).json({ success: false, error: 'User deactivated' });
      return;
    }

    if (user.tenantId !== tenantId) {
      res.status(401).json({ success: false, error: 'Tenant mismatch' });
      return;
    }

    const batchJob = await prisma.job.findFirst({
      where: {
        id: batchId,
        tenantId: tenantId,
      },
      select: { id: true }
    });

    if (!batchJob) {
      const jobWithBatch = await prisma.job.findFirst({
        where: {
          tenantId: tenantId,
          output: {
            path: ['batchId'],
            equals: batchId,
          },
        },
        select: { id: true }
      });

      if (!jobWithBatch) {
        logger.warn(`[SSE] Batch ${batchId} not found for tenant ${tenantId}`);
        res.status(404).json({ success: false, error: 'Batch not found' });
        return;
      }
    }

    logger.info(`[SSE] Client connected for batch ${batchId}, user ${userId}`);

    const clientId = sseService.addClient(res, tenantId);
    sseService.subscribeToChannel(clientId, `batch:${batchId}`);
    sseService.sendToClient(clientId, { type: 'subscribed', batchId, channel: `batch:${batchId}` });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ success: false, error: 'Invalid token' });
      return;
    }
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Token expired' });
      return;
    }
    logger.error(`[SSE] Authentication error: ${err}`);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
});

export default router;
