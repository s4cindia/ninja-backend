import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockJobFindFirst = vi.fn();
const mockUserFindFirst = vi.fn();
const mockJobUpdate = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
      update: (...args: unknown[]) => mockJobUpdate(...args),
    },
    user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let mockUser: Record<string, unknown> = {
  userId: 'admin-1', id: 'admin-1', role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com',
};

vi.mock('../../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = mockUser;
    next();
  },
}));

import adminJobsRoutes from '../../../../src/routes/admin/jobs.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminJobsRoutes);
  return app;
}

describe('PATCH /admin/jobs/:jobId/owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { userId: 'admin-1', id: 'admin-1', role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com' };
  });

  it('returns 403 for a non-admin', async () => {
    mockUser = { userId: 'user-1', id: 'user-1', role: 'USER', tenantId: 't-1' };

    const res = await request(buildApp()).patch('/admin/jobs/job-1/owner').send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('returns 422 when userId is missing from the body', async () => {
    const res = await request(buildApp()).patch('/admin/jobs/job-1/owner').send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the job does not exist in the admin\'s tenant', async () => {
    mockJobFindFirst.mockResolvedValue(null);

    const res = await request(buildApp()).patch('/admin/jobs/job-missing/owner').send({ userId: 'user-2' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the target user is not in the tenant', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', tenantId: 't-1', userId: 'old-owner' });
    mockUserFindFirst.mockResolvedValue(null);

    const res = await request(buildApp()).patch('/admin/jobs/job-1/owner').send({ userId: 'outsider' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('reassigns the job to the new owner', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', tenantId: 't-1', userId: 'old-owner' });
    mockUserFindFirst.mockResolvedValue({ id: 'new-owner', tenantId: 't-1' });
    mockJobUpdate.mockResolvedValue({ id: 'job-1', userId: 'new-owner' });

    const res = await request(buildApp()).patch('/admin/jobs/job-1/owner').send({ userId: 'new-owner' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'job-1', userId: 'new-owner' });
    expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { userId: 'new-owner' } });
  });
});
