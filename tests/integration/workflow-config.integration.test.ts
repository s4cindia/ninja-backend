/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/lib/prisma';
import { workflowConfigService } from '../../src/services/workflow/workflow-config.service';
import { workflowService } from '../../src/services/workflow/workflow.service';
import { queueService } from '../../src/services/queue.service';

// Mock services
vi.mock('../../src/services/workflow/workflow.service');
vi.mock('../../src/services/queue.service');
vi.mock('../../src/lib/prisma', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    file: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    job: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    workflowInstance: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

// Mock authentication middleware
vi.mock('../../src/middleware/auth.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.middleware')>();
  return {
    ...actual,
    authenticate: (req: any, res: any, next: any) => {
      req.user = {
        id: 'test-user-123',
        tenantId: 'test-tenant-123',
        email: 'test@example.com',
      };
      next();
    },
    authorize: (..._roles: string[]) => (req: any, res: any, next: any) => {
      next();
    },
    authenticateFlexible: (req: any, res: any, next: any) => {
      req.user = {
        id: 'test-user-123',
        tenantId: 'test-tenant-123',
        email: 'test@example.com',
      };
      next();
    },
  };
});

describe('Workflow Configuration Integration Tests', () => {
  const tenantId = 'test-tenant-123';
  const userId = 'test-user-123';
  const fileId = 'test-file-123';
  const workflowId = 'test-workflow-123';

  beforeEach(() => {
    vi.clearAllMocks();
    workflowConfigService.clearAllCache();
  });

  afterEach(() => {
    workflowConfigService.clearAllCache();
  });

  describe('Job Controller - Workflow Creation', () => {
    it('should NOT create workflow when disabled (default)', async () => {
      // Mock tenant with default settings (workflow disabled)
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      // Mock queue service
      vi.mocked(queueService.createJob).mockResolvedValue('job-123');
      vi.mocked(queueService.getJobStatus).mockResolvedValue({
        id: 'job-123',
        type: 'EPUB_AUDIT',
        status: 'PENDING',
        progress: 0,
        tenantId,
        userId,
      } as any);

      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'EPUB_AUDIT',
          fileId,
          priority: 'NORMAL',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.workflowId).toBeUndefined();
      expect(workflowService.createWorkflow).not.toHaveBeenCalled();
    });

    it('should create workflow when tenant enables it', async () => {
      // Mock tenant with workflow enabled
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
          },
        },
      } as any);

      // Mock queue service
      vi.mocked(queueService.createJob).mockResolvedValue('job-123');
      vi.mocked(queueService.getJobStatus).mockResolvedValue({
        id: 'job-123',
        type: 'EPUB_AUDIT',
        status: 'PENDING',
        progress: 0,
        tenantId,
        userId,
      } as any);

      // Mock workflow creation
      vi.mocked(workflowService.createWorkflow).mockResolvedValue({
        id: workflowId,
        fileId,
        createdBy: userId,
        currentState: 'UPLOAD_RECEIVED',
        stateData: {},
        retryCount: 0,
        loopCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        batchId: null,
      } as any);

      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'EPUB_AUDIT',
          fileId,
          priority: 'NORMAL',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.workflowId).toBe(workflowId);
      expect(workflowService.createWorkflow).toHaveBeenCalledWith(fileId, userId);
    });

    it('should create workflow with job-level override', async () => {
      // Mock tenant with workflow disabled
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: false,
          },
        },
      } as any);

      // Mock queue service
      vi.mocked(queueService.createJob).mockResolvedValue('job-123');
      vi.mocked(queueService.getJobStatus).mockResolvedValue({
        id: 'job-123',
        type: 'EPUB_AUDIT',
        status: 'PENDING',
        progress: 0,
        tenantId,
        userId,
      } as any);

      // Mock workflow creation
      vi.mocked(workflowService.createWorkflow).mockResolvedValue({
        id: workflowId,
        fileId,
        createdBy: userId,
        currentState: 'UPLOAD_RECEIVED',
        stateData: {},
        retryCount: 0,
        loopCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        batchId: null,
      } as any);

      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'EPUB_AUDIT',
          fileId,
          priority: 'NORMAL',
          options: {
            workflow: {
              workflowEnabled: true,
            },
          },
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.workflowId).toBe(workflowId);
      expect(workflowService.createWorkflow).toHaveBeenCalledWith(fileId, userId);
    });

    it('should NOT create workflow when job-level disables it', async () => {
      // Mock tenant with workflow enabled
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
          },
        },
      } as any);

      // Mock queue service
      vi.mocked(queueService.createJob).mockResolvedValue('job-123');
      vi.mocked(queueService.getJobStatus).mockResolvedValue({
        id: 'job-123',
        type: 'EPUB_AUDIT',
        status: 'PENDING',
        progress: 0,
        tenantId,
        userId,
      } as any);

      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'EPUB_AUDIT',
          fileId,
          priority: 'NORMAL',
          options: {
            workflow: {
              workflowEnabled: false,
            },
          },
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.workflowId).toBeUndefined();
      expect(workflowService.createWorkflow).not.toHaveBeenCalled();
    });

    it('should handle workflow creation failure gracefully', async () => {
      // Mock tenant with workflow enabled
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
          },
        },
      } as any);

      // Mock queue service
      vi.mocked(queueService.createJob).mockResolvedValue('job-123');
      vi.mocked(queueService.getJobStatus).mockResolvedValue({
        id: 'job-123',
        type: 'EPUB_AUDIT',
        status: 'PENDING',
        progress: 0,
        tenantId,
        userId,
      } as any);

      // Mock workflow creation failure
      vi.mocked(workflowService.createWorkflow).mockRejectedValue(
        new Error('Workflow creation failed')
      );

      // Job creation should still succeed
      const response = await request(app)
        .post('/api/v1/jobs')
        .send({
          type: 'EPUB_AUDIT',
          fileId,
          priority: 'NORMAL',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe('job-123');
      // workflowId should be undefined since creation failed
      expect(response.body.data.workflowId).toBeUndefined();
    });
  });

  describe('Tenant Configuration API', () => {
    it('should GET current workflow configuration', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
            hitlGates: {
              AWAITING_AI_REVIEW: 30000,
            },
          },
        },
      } as any);

      const response = await request(app)
        .get('/api/v1/tenant/config/workflow')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.enabled).toBe(true);
      expect(response.body.data.hitlGates.AWAITING_AI_REVIEW).toBe(30000);
    });

    it('should PATCH workflow configuration', async () => {
      // Mock current settings
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: false,
          },
        },
      } as any);

      // Mock update
      vi.mocked(prisma.tenant.update).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
            hitlGates: {
              AWAITING_AI_REVIEW: 60000,
            },
          },
        },
      } as any);

      const response = await request(app)
        .patch('/api/v1/tenant/config/workflow')
        .send({
          enabled: true,
          hitlGates: {
            AWAITING_AI_REVIEW: 60000,
          },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.enabled).toBe(true);
      expect(prisma.tenant.update).toHaveBeenCalled();
    });

    it('should validate configuration updates', async () => {
      const response = await request(app)
        .patch('/api/v1/tenant/config/workflow')
        .send({
          enabled: 'not-a-boolean', // Invalid
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid workflow configuration');
    });

    it('should reject negative timeout values', async () => {
      const response = await request(app)
        .patch('/api/v1/tenant/config/workflow')
        .send({
          hitlGates: {
            AWAITING_AI_REVIEW: -5000, // Invalid
          },
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should accept null timeout values', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {},
      } as any);

      vi.mocked(prisma.tenant.update).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
            hitlGates: {
              AWAITING_AI_REVIEW: null,
            },
          },
        },
      } as any);

      const response = await request(app)
        .patch('/api/v1/tenant/config/workflow')
        .send({
          hitlGates: {
            AWAITING_AI_REVIEW: null, // Valid - manual approval
          },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should clear cache after configuration update', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: false,
          },
        },
      } as any);

      vi.mocked(prisma.tenant.update).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
          },
        },
      } as any);

      // First GET to populate cache
      await request(app).get('/api/v1/tenant/config/workflow');
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);

      // PATCH to update config
      await request(app)
        .patch('/api/v1/tenant/config/workflow')
        .send({ enabled: true });

      // Second GET should hit DB again (cache cleared)
      await request(app).get('/api/v1/tenant/config/workflow');
      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(3); // 1 + 1 (update) + 1 (after clear)
    });
  });

  describe('HITL Timeout Configuration', () => {
    it('should use configured timeout for HITL gates', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
            hitlGates: {
              AWAITING_AI_REVIEW: 30000, // 30 seconds
            },
          },
        },
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_AI_REVIEW'
      );

      expect(timeout).toBe(30000);
    });

    it('should return null for manual approval gates', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: true,
            hitlGates: {
              AWAITING_ACR_SIGNOFF: null,
            },
          },
        },
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_ACR_SIGNOFF'
      );

      expect(timeout).toBe(null);
    });

    it('should use default timeout when not configured', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: null,
      } as any);

      const timeout = await workflowConfigService.getGateTimeout(
        tenantId,
        'AWAITING_AI_REVIEW'
      );

      expect(timeout).toBe(3600000); // Default 1 hour
    });
  });

  describe('Configuration Precedence', () => {
    it('should apply correct precedence: job > tenant > default', async () => {
      // Tenant settings
      vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
        id: tenantId,
        settings: {
          workflow: {
            enabled: false, // Tenant disabled
            hitlGates: {
              AWAITING_AI_REVIEW: 5000, // Tenant value
              AWAITING_REMEDIATION_REVIEW: 6000, // Tenant value
            },
          },
        },
      } as any);

      // Job options
      const jobOptions = {
        workflowEnabled: true, // Job override (should win)
        hitlGates: {
          AWAITING_AI_REVIEW: 10000, // Job override (should win)
          // AWAITING_REMEDIATION_REVIEW not set (should use tenant value)
          // AWAITING_CONFORMANCE_REVIEW not set (should use default)
        },
      };

      const config = await workflowConfigService.getEffectiveConfig(tenantId, jobOptions);

      expect(config.enabled).toBe(true); // Job override
      expect(config.hitlGates?.AWAITING_AI_REVIEW).toBe(10000); // Job override
      expect(config.hitlGates?.AWAITING_REMEDIATION_REVIEW).toBe(6000); // Tenant
      expect(config.hitlGates?.AWAITING_CONFORMANCE_REVIEW).toBe(3600000); // Default
    });
  });
});
