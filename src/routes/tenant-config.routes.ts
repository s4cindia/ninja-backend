import { Router } from 'express';
import { tenantConfigController } from '../controllers/tenant-config.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

/**
 * Tenant Configuration Routes
 * Authenticated endpoints for managing tenant-level workflow configuration.
 */

/**
 * GET /api/v1/tenant/config/workflow
 * Get current workflow configuration for the authenticated tenant.
 * Returns merged configuration (tenant settings + defaults).
 */
router.get(
  '/workflow',
  authenticate,
  tenantConfigController.getWorkflowConfig.bind(tenantConfigController)
);

/**
 * PATCH /api/v1/tenant/config/workflow
 * Update workflow configuration for the authenticated tenant.
 */
router.patch(
  '/workflow',
  authenticate,
  tenantConfigController.updateWorkflowConfig.bind(tenantConfigController)
);

/**
 * GET /api/v1/tenant/config/reports
 * Get current reports configuration for the authenticated tenant.
 * Returns: { explanationSource: 'hardcoded' | 'gemini' | 'hybrid' }
 */
router.get(
  '/reports',
  authenticate,
  tenantConfigController.getReportsConfig.bind(tenantConfigController)
);

/**
 * PATCH /api/v1/tenant/config/reports
 * Update reports configuration for the authenticated tenant.
 * Request body: { explanationSource?: 'hardcoded' | 'gemini' | 'hybrid' }
 */
router.patch(
  '/reports',
  authenticate,
  tenantConfigController.updateReportsConfig.bind(tenantConfigController)
);

/**
 * GET /api/v1/tenant/config/time-metrics
 * Get time metrics configuration (idleThresholdMinutes, gateBaselines).
 */
router.get(
  '/time-metrics',
  authenticate,
  tenantConfigController.getTimeMetricsConfig.bind(tenantConfigController)
);

/**
 * PATCH /api/v1/tenant/config/time-metrics
 * Update time metrics configuration.
 * Request body: { idleThresholdMinutes?: number, gateBaselines?: { AI_REVIEW?: number, ... } }
 */
router.patch(
  '/time-metrics',
  authenticate,
  tenantConfigController.updateTimeMetricsConfig.bind(tenantConfigController)
);

/**
 * GET /api/v1/tenant/config/ai-remediation
 * Get AI remediation configuration (modes, confidence threshold, auto-apply).
 */
router.get(
  '/ai-remediation',
  authenticate,
  tenantConfigController.getAiRemediationConfig.bind(tenantConfigController)
);

/**
 * PATCH /api/v1/tenant/config/ai-remediation
 * Update AI remediation configuration.
 */
router.patch(
  '/ai-remediation',
  authenticate,
  tenantConfigController.updateAiRemediationConfig.bind(tenantConfigController)
);

export default router;
