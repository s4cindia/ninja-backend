import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authorizeJob, authorizeJobForReview } from '../../src/middleware/authorize-job.middleware';
import { authorizeJobAccess } from '../../src/utils/authorization';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    job: {
      findFirst: vi.fn(),
    },
    teamMembership: {
      findFirst: vi.fn(),
    },
  },
}));

import prisma from '../../src/lib/prisma';

const createMockJob = (overrides = {}) => ({
  id: 'job-123',
  userId: 'user-A',
  tenantId: 'tenant-1',
  type: 'epub_audit' as const,
  status: 'completed' as const,
  productId: null,
  priority: 0,
  input: {},
  output: {},
  error: null,
  attempts: 1,
  maxAttempts: 3,
  progress: 100,
  tokensUsed: 0,
  costInr: 0,
  startedAt: new Date(),
  completedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('Authorization Tests', () => {
  const mockResponse = () => {
    const res: Partial<Response> = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res as Response;
  };

  const mockNext = vi.fn() as NextFunction;

  beforeAll(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // Per-test isolation for the RBAC Phase 2 tests below, which assert on
  // call counts/positions -- without this, mock call history accumulates
  // across tests in this file (there was previously no per-test reset).
  beforeEach(() => {
    vi.mocked(prisma.job.findFirst).mockReset();
    vi.mocked(prisma.teamMembership.findFirst).mockReset();
  });

  describe('authorizeJob middleware', () => {
    test('User cannot access other user job results', async () => {
      const req = {
        params: { jobId: 'job-123' },
        user: { id: 'user-A' },
      } as unknown as Request;
      const res = mockResponse();

      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await authorizeJob(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { message: 'Resource not found or access denied' },
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('Valid user can access own job results', async () => {
      const mockJob = createMockJob({ id: 'job-123', userId: 'user-A' });

      const req = {
        params: { jobId: 'job-123' },
        user: { id: 'user-A' },
      } as unknown as Request;
      const res = mockResponse();
      const next = vi.fn();

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob);

      await authorizeJob(req, res, next);

      expect(prisma.job.findFirst).toHaveBeenCalledWith({
        where: { id: 'job-123', userId: 'user-A' },
      });
      expect(next).toHaveBeenCalled();
      expect(req.job).toEqual(mockJob);
    });

    test('Unauthenticated access is blocked', async () => {
      const req = {
        params: { jobId: 'job-123' },
        user: undefined,
      } as unknown as Request;
      const res = mockResponse();

      await authorizeJob(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { message: 'Authentication required' },
      });
    });

    test('Missing jobId returns 400', async () => {
      const req = {
        params: {},
        user: { id: 'user-A' },
      } as unknown as Request;
      const res = mockResponse();

      await authorizeJob(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { message: 'Job ID is required' },
      });
    });
  });

  describe('authorizeJobAccess utility', () => {
    test('Returns job when user owns it', async () => {
      const mockJob = createMockJob({ id: 'job-456', userId: 'user-B' });

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob);

      const result = await authorizeJobAccess('job-456', 'user-B');

      expect(result).toEqual(mockJob);
    });

    test('Throws error when user does not own job', async () => {
      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await expect(authorizeJobAccess('job-789', 'wrong-user')).rejects.toThrow(
        'Job not found or access denied'
      );
    });

    // RBAC Phase 2: tier 2, ADMIN tenant-wide bypass.
    test('ADMIN can access any job in their own tenant, not just their own', async () => {
      const otherUsersJob = createMockJob({ id: 'job-999', userId: 'someone-else', tenantId: 'tenant-1' });
      vi.mocked(prisma.job.findFirst)
        .mockResolvedValueOnce(null) // tier 1: not the owner
        .mockResolvedValueOnce(otherUsersJob); // tier 2: ADMIN tenant-wide lookup

      const result = await authorizeJobAccess('job-999', 'admin-user', { role: 'ADMIN', tenantId: 'tenant-1' });

      expect(result).toEqual(otherUsersJob);
      expect(prisma.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-999', tenantId: 'tenant-1' } });
    });

    test('Non-ADMIN role does not get the tenant-wide bypass', async () => {
      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await expect(
        authorizeJobAccess('job-999', 'user-C', { role: 'USER', tenantId: 'tenant-1' })
      ).rejects.toThrow('Job not found or access denied');
    });

    // RBAC Phase 2: tier 3, TEAM_LEADER/VIEWER review access -- opt-in via
    // allowTeamReview, never granted by default (authorizeJob/mutating
    // routes must never pass this).
    test('allowTeamReview grants a TEAM_LEADER access to a teammate\'s job', async () => {
      const teammatesJob = createMockJob({ id: 'job-555', userId: 'owner-user', tenantId: 'tenant-1' });
      vi.mocked(prisma.job.findFirst)
        .mockResolvedValueOnce(null) // tier 1: not the owner
        .mockResolvedValueOnce(teammatesJob); // tier 3: tenant-scoped lookup before the team check
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue({
        id: 'membership-1', teamId: 'team-1', userId: 'leader-user', teamRole: 'TEAM_LEADER', createdAt: new Date(),
      });

      const result = await authorizeJobAccess('job-555', 'leader-user', {
        tenantId: 'tenant-1',
        allowTeamReview: true,
      });

      expect(result).toEqual(teammatesJob);
      expect(prisma.teamMembership.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'leader-user',
          teamRole: { in: ['TEAM_LEADER', 'VIEWER'] },
          team: { members: { some: { userId: 'owner-user' } } },
        },
      });
    });

    test('allowTeamReview grants a VIEWER the same read access as a TEAM_LEADER', async () => {
      const teammatesJob = createMockJob({ id: 'job-556', userId: 'owner-user', tenantId: 'tenant-1' });
      vi.mocked(prisma.job.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(teammatesJob);
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue({
        id: 'membership-2', teamId: 'team-1', userId: 'viewer-user', teamRole: 'VIEWER', createdAt: new Date(),
      });

      const result = await authorizeJobAccess('job-556', 'viewer-user', {
        tenantId: 'tenant-1',
        allowTeamReview: true,
      });

      expect(result).toEqual(teammatesJob);
    });

    test('Without allowTeamReview, a TEAM_LEADER teammate is still denied (strict/mutating routes)', async () => {
      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);
      // teamMembership.findFirst must never even be consulted when
      // allowTeamReview isn't set -- authorizeJob (mutating routes) must not
      // accidentally grant review-only access.
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue({
        id: 'membership-3', teamId: 'team-1', userId: 'leader-user', teamRole: 'TEAM_LEADER', createdAt: new Date(),
      });

      await expect(
        authorizeJobAccess('job-557', 'leader-user', { tenantId: 'tenant-1' })
      ).rejects.toThrow('Job not found or access denied');
      expect(prisma.teamMembership.findFirst).not.toHaveBeenCalled();
    });

    test('allowTeamReview denies someone with no shared team membership at all', async () => {
      const teammatesJob = createMockJob({ id: 'job-558', userId: 'owner-user', tenantId: 'tenant-1' });
      vi.mocked(prisma.job.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(teammatesJob);
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue(null);

      await expect(
        authorizeJobAccess('job-558', 'stranger-user', { tenantId: 'tenant-1', allowTeamReview: true })
      ).rejects.toThrow('Job not found or access denied');
    });
  });

  describe('authorizeJobForReview middleware', () => {
    test('Grants access to a TEAM_LEADER teammate (the capability authorizeJob never grants)', async () => {
      const teammatesJob = createMockJob({ id: 'job-700', userId: 'owner-user', tenantId: 'tenant-1' });
      const req = {
        params: { jobId: 'job-700' },
        user: { id: 'leader-user', role: 'USER', tenantId: 'tenant-1' },
      } as unknown as Request;
      const res = mockResponse();
      const next = vi.fn();

      vi.mocked(prisma.job.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(teammatesJob);
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue({
        id: 'membership-4', teamId: 'team-1', userId: 'leader-user', teamRole: 'TEAM_LEADER', createdAt: new Date(),
      });

      await authorizeJobForReview(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.job).toEqual(teammatesJob);
    });

    test('Still denies a stranger with no ownership, admin role, or shared team', async () => {
      const req = {
        params: { jobId: 'job-701' },
        user: { id: 'stranger-user', role: 'USER', tenantId: 'tenant-1' },
      } as unknown as Request;
      const res = mockResponse();

      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.teamMembership.findFirst).mockResolvedValue(null);

      await authorizeJobForReview(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('Unauthenticated access is blocked, same as authorizeJob', async () => {
      const req = {
        params: { jobId: 'job-702' },
        user: undefined,
      } as unknown as Request;
      const res = mockResponse();

      await authorizeJobForReview(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
