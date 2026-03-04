import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { metricsController } from '../controllers/metrics.controller';

const router = Router();

router.use(authenticate);

// Aggregate routes MUST come before /:workflowId to avoid Express shadowing
router.get('/aggregate/export', metricsController.exportAggregateCsv.bind(metricsController));
router.get('/aggregate', metricsController.getAggregateReport.bind(metricsController));

// Per-resource detail reports
router.get('/workflows/:workflowId', metricsController.getWorkflowDetailReport.bind(metricsController));
router.get('/batches/:batchId', metricsController.getBatchDetailReport.bind(metricsController));

export default router;
