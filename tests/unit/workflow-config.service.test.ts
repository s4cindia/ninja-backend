import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { workflowConfigService } from '../../src/services/workflow/workflow-config.service';
import {
  DEFAULT_WORKFLOW_CONFIG,
  TenantSettings,
  JobWorkflowOptions,
} from '../../src/types/workflow-config.types';
import prisma from '../../src/lib/prisma';

// Mock Prisma
vi.mock('../../src/lib/prisma', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock logger to reduce noise in tests
vi.mock('../../src/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('WorkflowConfigService', () => {
  const tenantId = 'test-tenant-123';

  beforeEach(() => {
    vi.clearAllMocks();
    workflowConfigService.clearAllCache();
  });

  afterEach(() => {
    workflowConfigService.clearAllCache();
  });

  describe('getEffectiveConfig', () => {
    it('should return default config when tenant has no settings', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config).toEqual(DEFAULT_WORKFLOW_CONFIG);
    });

    it('should merge tenant settings with defaults', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: 5000,
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config.enabled).toBe(true);
      expect(config.hitlGates?.AWAITING_AI_REVIEW).toBe(5000);
      // Should preserve defaults for other gates
      expect(config.hitlGates?.AWAITING_REMEDIATION_REVIEW).toBe(3600000);
    });

    it('should apply job-level overrides over tenant settings', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: false,
          hitlGates: {
            AWAITING_AI_REVIEW: 5000,
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const jobOptions: JobWorkflowOptions = {
        workflowEnabled: true,
        hitlGates: {
          AWAITING_AI_REVIEW: 10000,
        },
      };

      const config = await workflowConfigService.getEffectiveConfig(tenantId, jobOptions);

      expect(config.enabled).toBe(true); // Job override
      expect(config.hitlGates?.AWAITING_AI_REVIEW).toBe(10000); // Job override
    });

    it('should handle precedence correctly: job > tenant > default', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: 5000,
            AWAITING_REMEDIATION_REVIEW: 6000,
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const jobOptions: JobWorkflowOptions = {
        hitlGates: {
          AWAITING_AI_REVIEW: 10000,
          // AWAITING_REMEDIATION_REVIEW not specified, should use tenant value
        },
      };

      const config = await workflowConfigService.getEffectiveConfig(tenantId, jobOptions);

      expect(config.hitlGates?.AWAITING_AI_REVIEW).toBe(10000); // Job
      expect(config.hitlGates?.AWAITING_REMEDIATION_REVIEW).toBe(6000); // Tenant
      expect(config.hitlGates?.AWAITING_CONFORMANCE_REVIEW).toBe(3600000); // Default
    });

    it('should merge autoRetry configuration', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          autoRetry: {
            enabled: true,
            maxRetries: 5,
            backoffMs: 10000,
            retryableStates: ['FAILED', 'TIMEOUT'],
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config.autoRetry?.enabled).toBe(true);
      expect(config.autoRetry?.maxRetries).toBe(5);
      expect(config.autoRetry?.backoffMs).toBe(10000);
      expect(config.autoRetry?.retryableStates).toEqual(['FAILED', 'TIMEOUT']);
    });
  });

  describe('shouldCreateWorkflow', () => {
    it('should return false when workflow is disabled in defaults', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      const shouldCreate = await workflowConfigService.shouldCreateWorkflow(tenantId);

      expect(shouldCreate).toBe(false);
    });

    it('should return true when tenant enables workflow', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const shouldCreate = await workflowConfigService.shouldCreateWorkflow(tenantId);

      expect(shouldCreate).toBe(true);
    });

    it('should prioritize job-level override over tenant settings', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: false,
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const jobOptions: JobWorkflowOptions = {
        workflowEnabled: true,
      };

      const shouldCreate = await workflowConfigService.shouldCreateWorkflow(
        tenantId,
        jobOptions
      );

      expect(shouldCreate).toBe(true);
    });

    it('should respect job-level disable even when tenant enables', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const jobOptions: JobWorkflowOptions = {
        workflowEnabled: false,
      };

      const shouldCreate = await workflowConfigService.shouldCreateWorkflow(
        tenantId,
        jobOptions
      );

      expect(shouldCreate).toBe(false);
    });
  });

  describe('getGateTimeout', () => {
    it('should return null for ACR_SIGNOFF by default', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_ACR_SIGNOFF'
      );

      expect(timeout).toBe(null);
    });

    it('should return default timeout for AI_REVIEW', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_AI_REVIEW'
      );

      expect(timeout).toBe(3600000); // 1 hour
    });

    it('should return tenant-configured timeout', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: 30000, // 30 seconds
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_AI_REVIEW'
      );

      expect(timeout).toBe(30000);
    });

    it('should apply job-level timeout override', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: 30000,
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const jobOptions: JobWorkflowOptions = {
        hitlGates: {
          AWAITING_AI_REVIEW: 60000,
        },
      };

      const config = await workflowConfigService.getEffectiveConfig(tenantId, jobOptions);

      expect(config.hitlGates?.AWAITING_AI_REVIEW).toBe(60000);
    });

    it('should allow setting timeout to null (manual approval)', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: null,
          },
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_AI_REVIEW'
      );

      expect(timeout).toBe(null);
    });
  });

  describe('Cache behavior', () => {
    it('should cache tenant settings', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      // First call should hit database
      await workflowConfigService.getEffectiveConfig(tenantId);
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await workflowConfigService.getEffectiveConfig(tenantId);
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache on clearCache', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      await workflowConfigService.getEffectiveConfig(tenantId);
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);

      workflowConfigService.clearCache(tenantId);

      await workflowConfigService.getEffectiveConfig(tenantId);
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache entries', async () => {
      const tenant1 = 'tenant-1';
      const tenant2 = 'tenant-2';

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenant1,
        settings: null,
      } as any);

      await workflowConfigService.getEffectiveConfig(tenant1);
      await workflowConfigService.getEffectiveConfig(tenant2);

      workflowConfigService.clearAllCache();

      await workflowConfigService.getEffectiveConfig(tenant1);
      await workflowConfigService.getEffectiveConfig(tenant2);

      // Should hit DB 4 times (2 initial + 2 after cache clear)
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(4);
    });
  });

  describe('Edge cases', () => {
    it('should handle invalid tenant settings gracefully', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: 'invalid-json-string',
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config).toEqual(DEFAULT_WORKFLOW_CONFIG);
    });

    it('should handle empty tenant settings object', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {},
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config).toEqual(DEFAULT_WORKFLOW_CONFIG);
    });

    it('should handle partial tenant workflow config', async () => {
      const tenantSettings: TenantSettings = {
        workflow: {
          enabled: true,
          // Missing hitlGates and autoRetry
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config.enabled).toBe(true);
      expect(config.hitlGates).toEqual(DEFAULT_WORKFLOW_CONFIG.hitlGates);
      expect(config.autoRetry).toEqual(DEFAULT_WORKFLOW_CONFIG.autoRetry);
    });

    it('should handle malformed hitlGates object', async () => {
      const tenantSettings = {
        workflow: {
          enabled: true,
          hitlGates: 'not-an-object',
        },
      };

      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: tenantSettings,
      } as any);

      const config = await workflowConfigService.getEffectiveConfig(tenantId);

      expect(config.enabled).toBe(true);
      expect(config.hitlGates).toEqual(DEFAULT_WORKFLOW_CONFIG.hitlGates);
    });
  });
});
