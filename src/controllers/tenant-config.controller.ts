import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { workflowConfigService } from '../services/workflow/workflow-config.service';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import { z } from 'zod';
import type { ExplanationSource } from '../services/acr/explanation-catalog.service';

/**
 * Zod schema for workflow configuration updates.
 * Validates structure and types for tenant workflow settings.
 */
const reportsConfigUpdateSchema = z.object({
  explanationSource: z.enum(['hardcoded', 'gemini', 'hybrid']).optional(),
}).strict();

const timeMetricsConfigUpdateSchema = z.object({
  idleThresholdMinutes: z.number().int().min(1).max(60).optional(),
  gateBaselines: z.object({
    AI_REVIEW: z.number().int().positive().optional(),
    REMEDIATION_REVIEW: z.number().int().positive().optional(),
    CONFORMANCE_REVIEW: z.number().int().positive().optional(),
    ACR_SIGNOFF: z.number().int().positive().optional(),
  }).optional(),
}).strict();

const DEFAULT_TIME_METRICS_CONFIG = {
  idleThresholdMinutes: 2,
  gateBaselines: {
    AI_REVIEW: 15,
    REMEDIATION_REVIEW: 20,
    CONFORMANCE_REVIEW: 25,
    ACR_SIGNOFF: 10,
  },
};

const aiRemediationConfigUpdateSchema = z.object({
  tableFixMode: z.enum(['apply-to-pdf', 'guidance-only', 'summaries-to-pdf-headers-as-guidance']).optional(),
  altTextMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
  listMode: z.enum(['auto-resolve-decorative', 'guidance-only']).optional(),
  languageMode: z.enum(['apply-to-pdf', 'guidance-only']).optional(),
  colorContrastMode: z.enum(['guidance-only', 'disabled']).optional(),
  linkTextMode: z.enum(['guidance-only', 'disabled']).optional(),
  formFieldMode: z.enum(['guidance-only', 'disabled']).optional(),
  bookmarkMode: z.enum(['guidance-only', 'disabled']).optional(),
  confidenceThreshold: z.number().min(0.5).max(0.95).optional(),
  autoApplyHighConfidence: z.boolean().optional(),
}).strict();

export const DEFAULT_AI_REMEDIATION_CONFIG = {
  tableFixMode: 'summaries-to-pdf-headers-as-guidance' as const,
  altTextMode: 'apply-to-pdf' as const,
  listMode: 'auto-resolve-decorative' as const,
  languageMode: 'apply-to-pdf' as const,
  colorContrastMode: 'guidance-only' as const,
  linkTextMode: 'guidance-only' as const,
  formFieldMode: 'guidance-only' as const,
  bookmarkMode: 'guidance-only' as const,
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

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
  batchPolicy: z.object({
    /** When true, tenants may create fully headless batches with all gates set to auto-accept. */
    allowFullyHeadless: z.boolean().optional(),
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

      if (updates.batchPolicy) {
        const currentBatchPolicy = (currentWorkflow.batchPolicy && typeof currentWorkflow.batchPolicy === 'object')
          ? (currentWorkflow.batchPolicy as Record<string, unknown>)
          : {};

        updatedWorkflow.batchPolicy = {
          ...currentBatchPolicy,
          ...updates.batchPolicy,
        };
      }

      // Update tenant settings in database
      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: {
          settings: {
            ...currentSettings,
            workflow: updatedWorkflow,
          } as unknown as Prisma.InputJsonValue,
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

  /**
   * Get current reports configuration for the authenticated tenant.
   * Returns merged configuration (tenant settings + defaults).
   */
  async getReportsConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const settings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const reports = (settings.reports && typeof settings.reports === 'object')
        ? (settings.reports as Record<string, unknown>)
        : {};

      const config = {
        explanationSource: (reports.explanationSource as ExplanationSource) ?? 'hardcoded',
      };

      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update reports configuration for the authenticated tenant.
   */
  async updateReportsConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const validationResult = reportsConfigUpdateSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.badRequest('Invalid reports configuration: ' + validationResult.error.message);
      }

      const updates = validationResult.data;

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const currentSettings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const currentReports = (currentSettings.reports && typeof currentSettings.reports === 'object')
        ? (currentSettings.reports as Record<string, unknown>)
        : {};

      const updatedReports: Record<string, unknown> = { ...currentReports };
      if (updates.explanationSource !== undefined) {
        updatedReports.explanationSource = updates.explanationSource;
      }

      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: {
          settings: {
            ...currentSettings,
            reports: updatedReports,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[Tenant Config] Reports config updated for tenant ${req.user.tenantId}`, { updates });

      const config = {
        explanationSource: (updatedReports.explanationSource as ExplanationSource) ?? 'hardcoded',
      };

      res.json({
        success: true,
        data: config,
        message: 'Reports configuration updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get current time metrics configuration for the authenticated tenant.
   * Returns tenant settings merged with defaults.
   */
  async getTimeMetricsConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const settings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const stored = (settings.timeMetrics && typeof settings.timeMetrics === 'object')
        ? (settings.timeMetrics as Record<string, unknown>)
        : {};

      const storedBaselines = (stored.gateBaselines && typeof stored.gateBaselines === 'object')
        ? (stored.gateBaselines as Record<string, number>)
        : {};

      const config = {
        idleThresholdMinutes: (stored.idleThresholdMinutes as number | undefined) ?? DEFAULT_TIME_METRICS_CONFIG.idleThresholdMinutes,
        gateBaselines: {
          ...DEFAULT_TIME_METRICS_CONFIG.gateBaselines,
          ...storedBaselines,
        },
      };

      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update time metrics configuration for the authenticated tenant.
   */
  async updateTimeMetricsConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const validationResult = timeMetricsConfigUpdateSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.badRequest('Invalid time metrics configuration: ' + validationResult.error.message);
      }

      const updates = validationResult.data;

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const currentSettings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const currentTimeMetrics = (currentSettings.timeMetrics && typeof currentSettings.timeMetrics === 'object')
        ? (currentSettings.timeMetrics as Record<string, unknown>)
        : {};

      const updatedTimeMetrics: Record<string, unknown> = { ...currentTimeMetrics };

      if (updates.idleThresholdMinutes !== undefined) {
        updatedTimeMetrics.idleThresholdMinutes = updates.idleThresholdMinutes;
      }

      if (updates.gateBaselines) {
        const currentBaselines = (currentTimeMetrics.gateBaselines && typeof currentTimeMetrics.gateBaselines === 'object')
          ? (currentTimeMetrics.gateBaselines as Record<string, number>)
          : {};
        updatedTimeMetrics.gateBaselines = { ...currentBaselines, ...updates.gateBaselines };
      }

      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: {
          settings: {
            ...currentSettings,
            timeMetrics: updatedTimeMetrics,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[Tenant Config] Time metrics config updated for tenant ${req.user.tenantId}`, { updates });

      // Return the effective (merged) config
      const storedBaselines = (updatedTimeMetrics.gateBaselines && typeof updatedTimeMetrics.gateBaselines === 'object')
        ? (updatedTimeMetrics.gateBaselines as Record<string, number>)
        : {};

      const effectiveConfig = {
        idleThresholdMinutes: (updatedTimeMetrics.idleThresholdMinutes as number | undefined) ?? DEFAULT_TIME_METRICS_CONFIG.idleThresholdMinutes,
        gateBaselines: {
          ...DEFAULT_TIME_METRICS_CONFIG.gateBaselines,
          ...storedBaselines,
        },
      };

      res.json({
        success: true,
        data: effectiveConfig,
        message: 'Time metrics configuration updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Get current AI remediation configuration for the authenticated tenant.
   * Returns tenant settings merged with defaults.
   */
  async getAiRemediationConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const settings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const stored = (settings.aiRemediation && typeof settings.aiRemediation === 'object')
        ? (settings.aiRemediation as Record<string, unknown>)
        : {};

      const config = {
        ...DEFAULT_AI_REMEDIATION_CONFIG,
        ...stored,
      };

      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update AI remediation configuration for the authenticated tenant.
   */
  async updateAiRemediationConfig(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');

      const validationResult = aiRemediationConfigUpdateSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.badRequest('Invalid AI remediation configuration: ' + validationResult.error.message);
      }

      const updates = validationResult.data;

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { settings: true },
      });

      if (!tenant) throw AppError.notFound('Tenant not found');

      const currentSettings = (tenant.settings && typeof tenant.settings === 'object')
        ? (tenant.settings as Record<string, unknown>)
        : {};

      const currentAiRemediation = (currentSettings.aiRemediation && typeof currentSettings.aiRemediation === 'object')
        ? (currentSettings.aiRemediation as Record<string, unknown>)
        : {};

      const updatedAiRemediation: Record<string, unknown> = { ...currentAiRemediation, ...updates };

      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: {
          settings: {
            ...currentSettings,
            aiRemediation: updatedAiRemediation,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      logger.info(`[Tenant Config] AI remediation config updated for tenant ${req.user.tenantId}`, { updates });

      const effectiveConfig = { ...DEFAULT_AI_REMEDIATION_CONFIG, ...updatedAiRemediation };

      res.json({
        success: true,
        data: effectiveConfig,
        message: 'AI remediation configuration updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const tenantConfigController = new TenantConfigController();
