import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { sseService } from '../sse/sse.service';
import { AuthenticatedRequest } from '../types/authenticated-request';

const router = Router();

router.get('/batch/:batchId/progress', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const { batchId } = req.params;
  const tenantId = req.user?.tenantId;

  if (!tenantId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const clientId = sseService.addClient(res, tenantId);
  sseService.subscribeToChannel(clientId, `batch:${batchId}`);
});

export default router;
