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
 * Validates input, merges with existing settings, and clears cache.
 *
 * Request body:
 * {
 *   enabled?: boolean,
 *   hitlGates?: {
 *     AWAITING_AI_REVIEW?: number | null,
 *     AWAITING_REMEDIATION_REVIEW?: number | null,
 *     AWAITING_CONFORMANCE_REVIEW?: number | null,
 *     AWAITING_ACR_SIGNOFF?: number | null
 *   },
 *   autoRetry?: {
 *     enabled?: boolean,
 *     maxRetries?: number,
 *     backoffMs?: number,
 *     retryableStates?: string[]
 *   }
 * }
 */
router.patch(
  '/workflow',
  authenticate,
  tenantConfigController.updateWorkflowConfig.bind(tenantConfigController)
);

export default router;
