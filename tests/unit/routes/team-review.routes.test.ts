import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockJobFindFirst = vi.fn();
const mockTeamMembershipFindFirst = vi.fn();
const mockTeamReviewCreate = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: (...args: unknown[]) => mockJobFindFirst(...args) },
    teamMembership: { findFirst: (...args: unknown[]) => mockTeamMembershipFindFirst(...args) },
    teamReview: { create: (...args: unknown[]) => mockTeamReviewCreate(...args) },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let mockUser: Record<string, unknown> | undefined = {
  id: 'owner-1', userId: 'owner-1', role: 'USER', tenantId: 't-1',
};

vi.mock('../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = mockUser;
    next();
  },
}));

import teamReviewRoutes from '../../../src/routes/team-review.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', teamReviewRoutes);
  return app;
}

const ownerJob = { id: 'job-1', userId: 'owner-1', tenantId: 't-1' };

describe('POST /jobs/:jobId/team-review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'owner-1', userId: 'owner-1', role: 'USER', tenantId: 't-1' };
  });

  it('returns 401 when not authenticated', async () => {
    mockUser = undefined;

    const res = await request(buildApp()).post('/jobs/job-1/team-review').send({ outcome: 'OK' });

    expect(res.status).toBe(401);
    expect(mockTeamReviewCreate).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller has no access to the job at all', async () => {
    mockJobFindFirst.mockResolvedValue(null);

    const res = await request(buildApp()).post('/jobs/job-999/team-review').send({ outcome: 'OK' });

    expect(res.status).toBe(404);
    expect(mockTeamReviewCreate).not.toHaveBeenCalled();
  });

  it('the job owner can write a review for their own job (harmless self-review)', async () => {
    mockJobFindFirst.mockResolvedValue(ownerJob);
    mockTeamReviewCreate.mockResolvedValue({ id: 'review-1', jobId: 'job-1', reviewedBy: 'owner-1', outcome: 'OK' });

    const res = await request(buildApp()).post('/jobs/job-1/team-review').send({ outcome: 'OK' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Owner === job.userId -- never even reaches the TEAM_LEADER membership check.
    expect(mockTeamMembershipFindFirst).not.toHaveBeenCalled();
  });

  it('an ADMIN can write a review regardless of team membership', async () => {
    mockUser = { id: 'admin-1', userId: 'admin-1', role: 'ADMIN', tenantId: 't-1' };
    mockJobFindFirst
      .mockResolvedValueOnce(null) // authorizeJobForReview tier 1: not the owner
      .mockResolvedValueOnce(ownerJob); // tier 2: ADMIN tenant-wide bypass
    mockTeamReviewCreate.mockResolvedValue({ id: 'review-2', jobId: 'job-1', reviewedBy: 'admin-1', outcome: 'OK' });

    const res = await request(buildApp()).post('/jobs/job-1/team-review').send({ outcome: 'OK' });

    expect(res.status).toBe(201);
    expect(mockTeamMembershipFindFirst).not.toHaveBeenCalled();
  });

  it('a TEAM_LEADER teammate can write a review for the job owner\'s job', async () => {
    mockUser = { id: 'leader-1', userId: 'leader-1', role: 'USER', tenantId: 't-1' };
    mockJobFindFirst
      .mockResolvedValueOnce(null) // tier 1: not the owner
      .mockResolvedValueOnce(ownerJob); // tier 3: tenant-scoped lookup before the team check
    mockTeamMembershipFindFirst.mockResolvedValue({ id: 'm-1', teamRole: 'TEAM_LEADER' });
    mockTeamReviewCreate.mockResolvedValue({ id: 'review-3', jobId: 'job-1', reviewedBy: 'leader-1', outcome: 'NEEDS_CORRECTION', notes: 'fix the alt text' });

    const res = await request(buildApp())
      .post('/jobs/job-1/team-review')
      .send({ outcome: 'NEEDS_CORRECTION', notes: 'fix the alt text' });

    expect(res.status).toBe(201);
    expect(mockTeamReviewCreate).toHaveBeenCalledWith({
      data: { jobId: 'job-1', reviewedBy: 'leader-1', outcome: 'NEEDS_CORRECTION', notes: 'fix the alt text' },
    });
  });

  it('a VIEWER teammate is rejected with 403 even though they can read the job (never a VIEWER\'s action)', async () => {
    mockUser = { id: 'viewer-1', userId: 'viewer-1', role: 'USER', tenantId: 't-1' };
    mockJobFindFirst
      .mockResolvedValueOnce(null) // tier 1: not the owner
      .mockResolvedValueOnce(ownerJob); // tier 3: authorizeJobForReview itself grants read access to a VIEWER too
    // A real DB query filters by teamRole -- the middleware's own check
    // (teamRole in [TEAM_LEADER, VIEWER]) matches this VIEWER and grants
    // read access, but the route handler's own stricter check (teamRole ===
    // TEAM_LEADER exactly) must NOT match, so the mock has to actually
    // honor the where-clause's teamRole filter rather than returning the
    // same canned membership for every call.
    mockTeamMembershipFindFirst.mockImplementation(({ where }: { where: { teamRole: string | { in: string[] } } }) => {
      const filter = where.teamRole;
      const matches = typeof filter === 'string' ? filter === 'VIEWER' : filter.in.includes('VIEWER');
      return Promise.resolve(matches ? { id: 'm-2', teamRole: 'VIEWER' } : null);
    });

    const res = await request(buildApp()).post('/jobs/job-1/team-review').send({ outcome: 'OK' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockTeamReviewCreate).not.toHaveBeenCalled();
  });

  it('returns 422 for an invalid outcome value', async () => {
    mockJobFindFirst.mockResolvedValue(ownerJob);

    const res = await request(buildApp()).post('/jobs/job-1/team-review').send({ outcome: 'MAYBE' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockTeamReviewCreate).not.toHaveBeenCalled();
  });
});
