import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authorizeJob } from '../../src/middleware/authorize-job.middleware';
import { authorizeJobAccess } from '../../src/utils/authorization';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    job: {
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
  });
});
