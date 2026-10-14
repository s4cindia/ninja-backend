/**
 * SSE routes -- covers only the new GET /sse/pdf/:jobId/apply-progress
 * endpoint (live progress for ai-analysis.service.ts's
 * applyApprovedSuggestions), a direct structural mirror of the pre-existing
 * GET /sse/batch/:batchId/progress route's auth + tenant-ownership check.
 * Neither that route nor GET /sse/subscribe had any prior test coverage --
 * out of scope here, this file only covers the route this change adds.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    job: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// addClient's real implementation holds the HTTP response open indefinitely
// (SSE semantics) -- the mock calls res.end() itself so supertest's request
// completes, while still letting the success-path assertions below check
// subscribeToChannel was called with the right channel.
vi.mock('../../../src/sse/sse.service', () => ({
  sseService: {
    addClient: vi.fn((res: any) => {
      res.end();
      return 'client-1';
    }),
    subscribeToChannel: vi.fn(),
    sendToClient: vi.fn(),
  },
}));

import prisma from '../../../src/lib/prisma';
import { sseService } from '../../../src/sse/sse.service';
import sseRoutes from '../../../src/routes/sse.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/sse', sseRoutes);
  return app;
}

const JWT_SECRET = 'test-secret';

describe('GET /sse/pdf/:jobId/apply-progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(buildApp()).get('/sse/pdf/job-1/apply-progress');

    expect(res.status).toBe(401);
    expect(sseService.addClient).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(buildApp()).get('/sse/pdf/job-1/apply-progress?token=not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(sseService.addClient).not.toHaveBeenCalled();
  });

  it('returns 401 when the token user is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any);
    const token = jwt.sign({ userId: 'user-1', tenantId: 't-1' }, JWT_SECRET);

    const res = await request(buildApp()).get(`/sse/pdf/job-1/apply-progress?token=${token}`);

    expect(res.status).toBe(401);
    expect(sseService.addClient).not.toHaveBeenCalled();
  });

  it('returns 401 on a tenant mismatch between the token and the stored user', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', tenantId: 't-2', deletedAt: null } as any);
    const token = jwt.sign({ userId: 'user-1', tenantId: 't-1' }, JWT_SECRET);

    const res = await request(buildApp()).get(`/sse/pdf/job-1/apply-progress?token=${token}`);

    expect(res.status).toBe(401);
    expect(sseService.addClient).not.toHaveBeenCalled();
  });

  it('returns 404 when the job does not belong to the tenant', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', tenantId: 't-1', deletedAt: null } as any);
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    const token = jwt.sign({ userId: 'user-1', tenantId: 't-1' }, JWT_SECRET);

    const res = await request(buildApp()).get(`/sse/pdf/job-1/apply-progress?token=${token}`);

    expect(res.status).toBe(404);
    expect(sseService.addClient).not.toHaveBeenCalled();
  });

  it('subscribes the client to apply-progress:<jobId> for a valid request', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', tenantId: 't-1', deletedAt: null } as any);
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1' } as any);
    const token = jwt.sign({ userId: 'user-1', tenantId: 't-1' }, JWT_SECRET);

    await request(buildApp()).get(`/sse/pdf/job-1/apply-progress?token=${token}`);

    expect(prisma.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', tenantId: 't-1' }, select: { id: true } });
    expect(sseService.addClient).toHaveBeenCalledWith(expect.anything(), 't-1');
    expect(sseService.subscribeToChannel).toHaveBeenCalledWith('client-1', 'apply-progress:job-1');
    expect(sseService.sendToClient).toHaveBeenCalledWith('client-1', { type: 'subscribed', jobId: 'job-1', channel: 'apply-progress:job-1' });
  });
});
