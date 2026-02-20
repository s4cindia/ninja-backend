import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { workflowConfigService } from '../services/workflow/workflow-config.service';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import { z } from 'zod';

/**
 * Zod schema for workflow configuration updates.
 * Validates structure and types for tenant workflow settings.
 */
const workflowConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  hitlGates: z.object({
    AWAITING_AI_REVIEW: z.number().int().positive().or(z.null()).optional(),
    AWAITING_REMEDIATION_REVIEW: z.number().int().positive().or(z.null()).optional(),
    AWAITING_CONFORMANCE_REVIEW: z.number().int().positive().or(z.null()).optional(),
    AWAITING_ACR_SIGNOFF: z.number().int().positive().or(z.null()).optional(),
  }).optional(),
  autoRetry: z.object({
    enabled: z.boolean().optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    backoffMs: z.number().int().positive().optional(),
    retryableStates: z.array(z.string()).optional(),
  }).optional(),
}).strict();

type WorkflowConfigUpdate = z.infer<typeof workflowConfigUpdateSchema>;

/**
 * Controller for managing tenant-level workflow configuration.
 * Allows tenants to enable/disable workflows and configure HITL timeouts.
 */
export class TenantConfigController {
  /**
   * Get current workflow configuration for the authenticated tenant.
   * Returns merged configuration (tenant settings + defaults).
   *
   * @param req - Request with authenticated user
   * @param res - Response with workflow configuration
   * @param next - Next function for error handling
   */
  async getWorkflowConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      const config = await workflowConfigService.getEffectiveConfig(req.user.tenantId);

      res.json({
        success: true,
        data: config,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update workflow configuration for the authenticated tenant.
   * Validates input, merges with existing settings, and clears cache.
   *
   * @param req - Request with workflow configuration updates in body
   * @param res - Response with updated configuration
   * @param next - Next function for error handling
   */
  async updateWorkflowConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized('Not authenticated');
      }

      // Validate request body
      const validationResult = workflowConfigUpdateSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.badRequest(
          'Invalid workflow configuration: ' + validationResult.error.message
        );
      }

      const updates: WorkflowConfigUpdate = validationResult.data;

      // Fetch current tenant settings
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) {
        throw AppError.notFound('Tenant not found');
      }

      // Parse existing settings
      const currentSettings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const currentWorkflow = (currentSettings.workflow && typeof currentSettings.workflow === 'object')
        ? (currentSettings.workflow as Record<string, unknown>)
        : {};

      // Deep merge updates into current workflow config
      const updatedWorkflow: Record<string, unknown> = { ...currentWorkflow };

      if (updates.enabled !== undefined) {
        updatedWorkflow.enabled = updates.enabled;
      }

      if (updates.hitlGates) {
        const currentGates = (currentWorkflow.hitlGates && typeof currentWorkflow.hitlGates === 'object')
          ? (currentWorkflow.hitlGates as Record<string, unknown>)
          : {};

        updatedWorkflow.hitlGates = {
          ...currentGates,
          ...updates.hitlGates,
        };
      }

      if (updates.autoRetry) {
        const currentRetry = (currentWorkflow.autoRetry && typeof currentWorkflow.autoRetry === 'object')
          ? (currentWorkflow.autoRetry as Record<string, unknown>)
          : {};

        updatedWorkflow.autoRetry = {
          ...currentRetry,
          ...updates.autoRetry,
        };
      }

      // Update tenant settings in database
      const updatedTenant = await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: {
          settings: {
            ...currentSettings,
            workflow: updatedWorkflow,
          },
        },
      });

      // Clear cache to ensure next request fetches updated settings
      workflowConfigService.clearCache(req.user.tenantId);

      logger.info(`[Tenant Config] Workflow config updated for tenant ${req.user.tenantId}`, {
        updates,
      });

      // Return effective configuration (merged with defaults)
      const effectiveConfig = await workflowConfigService.getEffectiveConfig(req.user.tenantId);

      res.json({
        success: true,
        data: effectiveConfig,
        message: 'Workflow configuration updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const tenantConfigController = new TenantConfigController();
