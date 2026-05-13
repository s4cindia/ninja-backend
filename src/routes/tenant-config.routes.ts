import { Router } from 'express';
import { tenantConfigController } from '../controllers/tenant-config.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

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

/**
 * GET /api/v1/tenant/config/prh
 * Get PRH UK tenant config (currently the AI-altext gate flag + audit
 * trail of last-flipped userId / timestamp). Returns
 * { aiAltTextEnabled: false, aiAltTextEnabledBy: null,
 *   aiAltTextEnabledAt: null } when never touched — disabled-by-default
 * per Style Guide Appendix 7.
 */
router.get(
  '/prh',
  authenticate,
  tenantConfigController.getPrhConfig.bind(tenantConfigController)
);

/**
 * PATCH /api/v1/tenant/config/prh
 * Update PRH UK tenant config. ADMIN-ONLY — flipping the AI gate is
 * a policy attestation that the tenant has completed PRH UK vetting
 * per Appendix 7. Body: { aiAltTextEnabled: boolean }. Audit trail
 * (aiAltTextEnabledBy / aiAltTextEnabledAt) is server-stamped from
 * req.user.id and the current time.
 */
router.patch(
  '/prh',
  authenticate,
  authorize('ADMIN'),
  tenantConfigController.updatePrhConfig.bind(tenantConfigController)
);

export default router;
