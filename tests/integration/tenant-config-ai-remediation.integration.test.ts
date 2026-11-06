/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/index';
import prisma from '../../src/lib/prisma';

// Mock prisma only -- the real `authorize` middleware runs unmocked below,
// so this test exercises the actual ADMIN role check, not a bypassed one.
vi.mock('../../src/lib/prisma', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Only `authenticate` is mocked, with a role this file's tests can flip --
// `authorize` is left as the real implementation (auth.middleware.ts) so
// this is a genuine regression test for the route-level ADMIN gate added
// to PATCH /tenant/config/ai-remediation, not a bypassed check.
let currentRole = 'OPERATOR';
vi.mock('../../src/middleware/auth.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.middleware')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = {
        id: 'test-user-123',
        tenantId: 'test-tenant-123',
        email: 'test@example.com',
        role: currentRole,
      };
      next();
    },
  };
});

describe('PATCH /api/v1/tenant/config/ai-remediation -- ADMIN gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRole = 'OPERATOR';
  });

  it('rejects a non-admin (OPERATOR) with 403, and does not touch the tenant', async () => {
    currentRole = 'OPERATOR';

    const response = await request(app)
      .patch('/api/v1/tenant/config/ai-remediation')
      .send({ colorContrastMode: 'apply-to-pdf' })
      .expect(403);

    expect(response.body.success).toBe(false);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('allows an ADMIN to update the configuration', async () => {
    currentRole = 'ADMIN';

    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'test-tenant-123',
      settings: { aiRemediation: { colorContrastMode: 'guidance-only' } },
    } as any);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as any);

    const response = await request(app)
      .patch('/api/v1/tenant/config/ai-remediation')
      .send({ colorContrastMode: 'apply-to-pdf' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.colorContrastMode).toBe('apply-to-pdf');
    expect(prisma.tenant.update).toHaveBeenCalled();
  });

  it('still allows GET for a non-admin (read-only, unaffected by the new gate)', async () => {
    currentRole = 'OPERATOR';

    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'test-tenant-123',
      settings: {},
    } as any);

    const response = await request(app)
      .get('/api/v1/tenant/config/ai-remediation')
      .expect(200);

    expect(response.body.success).toBe(true);
  });
});
