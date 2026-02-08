import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { verificationController } from '../controllers/verification.controller';

const router = Router();

router.use(authenticate);

router.get('/methods', verificationController.getMethods.bind(verificationController));

router.get('/:jobId/queue', verificationController.getQueue.bind(verificationController));
router.get('/:jobId/queue/filter', verificationController.filterQueue.bind(verificationController));
router.get('/:jobId/audit-log', verificationController.getAuditLog.bind(verificationController));
router.get('/:jobId/audit-log/export', verificationController.exportAuditLog.bind(verificationController));
router.get('/:jobId/can-finalize', verificationController.canFinalize.bind(verificationController));

router.post('/:itemId/submit', verificationController.submitVerification.bind(verificationController));
router.post('/bulk', verificationController.bulkVerify.bind(verificationController));

export default router;
