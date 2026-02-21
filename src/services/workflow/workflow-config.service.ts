/**
 * @fileoverview Workflow configuration service.
 * Manages tenant-level and job-level workflow configuration with caching.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
  WorkflowConfig,
  TenantSettings,
  JobWorkflowOptions,
  HitlGateConfig,
  DEFAULT_WORKFLOW_CONFIG,
} from '../../types/workflow-config.types';

/**
 * Cache entry for tenant settings with TTL.
 */
interface CacheEntry {
  settings: TenantSettings;
  expiresAt: number;
}

/**
 * Workflow configuration service.
 * Provides methods to read, merge, and cache workflow configuration
 * from tenant settings and job-level overrides.
 */
class WorkflowConfigService {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Get effective workflow configuration for a job.
   * Merges tenant settings with job-level overrides.
   * Precedence: job options > tenant settings > defaults
   *
   * @param tenantId - Tenant ID
   * @param jobOptions - Optional job-level workflow options
   * @returns Effective workflow configuration
   */
  async getEffectiveConfig(
    tenantId: string,
    jobOptions?: JobWorkflowOptions
  ): Promise<WorkflowConfig> {
    // 1. Read tenant settings (with caching)
    const tenantSettings = await this.getTenantSettings(tenantId);
    const tenantWorkflowConfig = tenantSettings.workflow || {};

    // 2. Merge configurations with precedence: job > tenant > default
    const effectiveConfig = this.mergeConfigs(
      DEFAULT_WORKFLOW_CONFIG,
      tenantWorkflowConfig,
      jobOptions
    );

    logger.debug('[WorkflowConfig] Effective config computed', {
      tenantId,
      enabled: effectiveConfig.enabled,
      hasJobOverride: !!jobOptions,
    });

    return effectiveConfig;
  }

  /**
   * Check if workflow should be created for this tenant/job.
   *
   * @param tenantId - Tenant ID
   * @param jobOptions - Optional job-level workflow options
   * @returns True if workflow should be created
   */
  async shouldCreateWorkflow(
    tenantId: string,
    jobOptions?: JobWorkflowOptions
  ): Promise<boolean> {
    const config = await this.getEffectiveConfig(tenantId, jobOptions);

    // Job-level override takes precedence
    if (jobOptions?.workflowEnabled !== undefined) {
      logger.info('[WorkflowConfig] Job-level override applied', {
        tenantId,
        override: jobOptions.workflowEnabled,
      });
      return jobOptions.workflowEnabled;
    }

    return config.enabled;
  }

  /**
   * Get HITL gate timeout for a specific gate.
   *
   * @param tenantId - Tenant ID
   * @param gateName - Name of the HITL gate
   * @param jobOptions - Optional job-level workflow options
   * @returns Timeout in milliseconds, or null for no timeout
   */
  async getGateTimeout(
    tenantId: string,
    gateName: keyof HitlGateConfig,
    jobOptions?: JobWorkflowOptions
  ): Promise<number | null> {
    const config = await this.getEffectiveConfig(tenantId, jobOptions);
    const timeout = config.hitlGates?.[gateName];

    logger.debug('[WorkflowConfig] Gate timeout retrieved', {
      tenantId,
      gateName,
      timeout: timeout === null ? 'none' : `${timeout}ms`,
    });

    return timeout ?? null;
  }

  /**
   * Clear cached settings for a tenant.
   * Call this after updating tenant settings.
   *
   * @param tenantId - Tenant ID
   */
  clearCache(tenantId: string): void {
    this.cache.delete(tenantId);
    logger.info('[WorkflowConfig] Cache cleared for tenant', { tenantId });
  }

  /**
   * Clear all cached settings.
   */
  clearAllCache(): void {
    this.cache.clear();
    logger.info('[WorkflowConfig] All cache cleared');
  }

  /**
   * Get tenant settings from cache or database.
   *
   * @param tenantId - Tenant ID
   * @returns Tenant settings
   */
  private async getTenantSettings(tenantId: string): Promise<TenantSettings> {
    // Check cache
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('[WorkflowConfig] Cache hit', { tenantId });
      return cached.settings;
    }

    logger.debug('[WorkflowConfig] Cache miss, fetching from DB', { tenantId });

    // Fetch from database
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    const settings = this.parseTenantSettings(tenant?.settings);

    // Update cache
    this.cache.set(tenantId, {
      settings,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return settings;
  }

  /**
   * Parse tenant settings JSON with safe fallback.
   *
   * @param settings - Raw settings from database (unknown type)
   * @returns Parsed tenant settings
   */
  private parseTenantSettings(settings: unknown): TenantSettings {
    if (!settings || typeof settings !== 'object') {
      return {};
    }

    // Safe type assertion after runtime check
    const parsed = settings as Record<string, unknown>;

    // Validate workflow config structure if it exists
    if (parsed.workflow && typeof parsed.workflow === 'object') {
      // Basic structure validation
      const workflow = parsed.workflow as Record<string, unknown>;

      return {
        workflow: {
          enabled: typeof workflow.enabled === 'boolean' ? workflow.enabled : false,
          hitlGates: this.parseHitlGates(workflow.hitlGates),
          autoRetry: this.parseAutoRetry(workflow.autoRetry),
        },
      };
    }

    return {};
  }

  /**
   * Parse HITL gates configuration with validation.
   */
  private parseHitlGates(gates: unknown): HitlGateConfig | undefined {
    if (!gates || typeof gates !== 'object') {
      return undefined;
    }

    const parsed = gates as Record<string, unknown>;
    const result: HitlGateConfig = {};

    const validGates: (keyof HitlGateConfig)[] = [
      'AWAITING_AI_REVIEW',
      'AWAITING_REMEDIATION_REVIEW',
      'AWAITING_CONFORMANCE_REVIEW',
      'AWAITING_ACR_SIGNOFF',
    ];

    for (const gate of validGates) {
      const value = parsed[gate];
      if (value === null || typeof value === 'number') {
        result[gate] = value as number | null;
      }
    }

    return result;
  }

  /**
   * Parse auto-retry configuration with validation.
   */
  private parseAutoRetry(retry: unknown) {
    if (!retry || typeof retry !== 'object') {
      return undefined;
    }

    const parsed = retry as Record<string, unknown>;

    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      maxRetries: typeof parsed.maxRetries === 'number' ? parsed.maxRetries : 3,
      backoffMs: typeof parsed.backoffMs === 'number' ? parsed.backoffMs : 5000,
      retryableStates: Array.isArray(parsed.retryableStates) ? parsed.retryableStates : ['FAILED'],
    };
  }

  /**
   * Deep merge workflow configurations.
   * Precedence: job > tenant > default
   */
  private mergeConfigs(
    defaultConfig: WorkflowConfig,
    tenantConfig: Partial<WorkflowConfig>,
    jobOptions?: JobWorkflowOptions
  ): WorkflowConfig {
    // Start with default
    const merged: WorkflowConfig = { ...defaultConfig };

    // Apply tenant config
    if (tenantConfig.enabled !== undefined) {
      merged.enabled = tenantConfig.enabled;
    }

    if (tenantConfig.hitlGates) {
      merged.hitlGates = {
        ...merged.hitlGates,
        ...tenantConfig.hitlGates,
      };
    }

    if (tenantConfig.autoRetry) {
      merged.autoRetry = {
        ...merged.autoRetry,
        ...tenantConfig.autoRetry,
      };
    }

    // Apply job-level overrides
    if (jobOptions) {
      if (jobOptions.workflowEnabled !== undefined) {
        merged.enabled = jobOptions.workflowEnabled;
      }

      if (jobOptions.hitlGates) {
        merged.hitlGates = {
          ...merged.hitlGates,
          ...jobOptions.hitlGates,
        };
      }

      if (jobOptions.autoRetry) {
        merged.autoRetry = {
          ...merged.autoRetry!,
          ...jobOptions.autoRetry,
        };
      }
    }

    return merged;
  }
}

// Export singleton instance
export const workflowConfigService = new WorkflowConfigService();
