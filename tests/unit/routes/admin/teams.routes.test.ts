import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// --- Prisma mock ---
const mockTeamCreate = vi.fn();
const mockTeamFindMany = vi.fn();
const mockTeamFindFirst = vi.fn();
const mockUserFindFirst = vi.fn();
const mockMembershipUpsert = vi.fn();
const mockMembershipDeleteMany = vi.fn();
const mockTeamDelete = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    team: {
      create: (...args: unknown[]) => mockTeamCreate(...args),
      findMany: (...args: unknown[]) => mockTeamFindMany(...args),
      findFirst: (...args: unknown[]) => mockTeamFindFirst(...args),
      delete: (...args: unknown[]) => mockTeamDelete(...args),
    },
    user: {
      findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
    },
    teamMembership: {
      upsert: (...args: unknown[]) => mockMembershipUpsert(...args),
      deleteMany: (...args: unknown[]) => mockMembershipDeleteMany(...args),
    },
  },
}));

// --- Logger mock ---
vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// --- Auth mock ---
let mockUser: Record<string, unknown> = {
  userId: 'admin-1', id: 'admin-1',
  role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com',
};

vi.mock('../../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = mockUser;
    next();
  },
}));

import adminTeamsRoutes from '../../../../src/routes/admin/teams.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminTeamsRoutes);
  return app;
}

describe('admin/teams.routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      userId: 'admin-1', id: 'admin-1',
      role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com',
    };
  });

  // Test 1 — POST /admin/teams: creates a tenant-scoped team
  it('POST /admin/teams creates a team', async () => {
    mockTeamCreate.mockResolvedValue({ id: 'team-1', name: 'Cell A', tenantId: 't-1' });

    const app = buildApp();
    const res = await request(app).post('/admin/teams').send({ name: 'Cell A' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('team-1');
    expect(mockTeamCreate).toHaveBeenCalledWith({ data: { name: 'Cell A', tenantId: 't-1' } });
  });

  // Test 2 — POST /admin/teams: non-admin returns 403
  it('POST /admin/teams returns 403 for non-admin', async () => {
    mockUser = { userId: 'user-2', id: 'user-2', role: 'USER', tenantId: 't-1' };

    const app = buildApp();
    const res = await request(app).post('/admin/teams').send({ name: 'Cell A' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockTeamCreate).not.toHaveBeenCalled();
  });

  // Test 3 — POST /admin/teams: empty name → 422
  it('POST /admin/teams returns 422 for empty name', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/teams').send({ name: '' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // Test 4 — GET /admin/teams: returns list scoped to tenant, with members
  it('GET /admin/teams returns team list scoped to tenant', async () => {
    mockTeamFindMany.mockResolvedValue([
      { id: 'team-1', name: 'Cell A', tenantId: 't-1', members: [] },
    ]);

    const app = buildApp();
    const res = await request(app).get('/admin/teams');

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toHaveLength(1);
    expect(mockTeamFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't-1' },
        include: expect.objectContaining({ members: expect.anything() }),
      }),
    );
  });

  // Test 5 — GET /admin/teams/:id: returns a team
  it('GET /admin/teams/:id returns a single team', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', name: 'Cell A', tenantId: 't-1', members: [] });

    const app = buildApp();
    const res = await request(app).get('/admin/teams/team-1');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('team-1');
    expect(mockTeamFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'team-1', tenantId: 't-1' } }),
    );
  });

  // Test 6 — GET /admin/teams/:id: 404 for a team in another tenant
  it('GET /admin/teams/:id returns 404 when team is not in the admin\'s tenant', async () => {
    mockTeamFindFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).get('/admin/teams/other-tenant-team');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // Test 7 — POST /admin/teams/:id/members: upserts a membership
  it('POST /admin/teams/:id/members adds a member with a role', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });
    mockUserFindFirst.mockResolvedValue({ id: 'user-5', tenantId: 't-1' });
    mockMembershipUpsert.mockResolvedValue({ id: 'mem-1', teamId: 'team-1', userId: 'user-5', teamRole: 'TEAM_LEADER' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/teams/team-1/members')
      .send({ userId: 'user-5', teamRole: 'TEAM_LEADER' });

    expect(res.status).toBe(201);
    expect(res.body.data.teamRole).toBe('TEAM_LEADER');
    expect(mockMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId_userId: { teamId: 'team-1', userId: 'user-5' } },
        create: { teamId: 'team-1', userId: 'user-5', teamRole: 'TEAM_LEADER' },
        update: { teamRole: 'TEAM_LEADER' },
      }),
    );
  });

  // Test 8 — POST /admin/teams/:id/members: invalid teamRole → 422
  it('POST /admin/teams/:id/members returns 422 for an invalid teamRole', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/teams/team-1/members')
      .send({ userId: 'user-5', teamRole: 'MANAGER' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockMembershipUpsert).not.toHaveBeenCalled();
  });

  // Test 9 — POST /admin/teams/:id/members: team not found → 404
  it('POST /admin/teams/:id/members returns 404 when the team does not exist', async () => {
    mockTeamFindFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/admin/teams/missing-team/members')
      .send({ userId: 'user-5', teamRole: 'EXECUTIVE' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockMembershipUpsert).not.toHaveBeenCalled();
  });

  // Test 10 — POST /admin/teams/:id/members: target user outside the tenant → 404
  it('POST /admin/teams/:id/members returns 404 when the user is not in the tenant', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });
    mockUserFindFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/admin/teams/team-1/members')
      .send({ userId: 'user-from-other-tenant', teamRole: 'EXECUTIVE' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    expect(mockMembershipUpsert).not.toHaveBeenCalled();
  });

  // Test 11a — DELETE /admin/teams/:id: deletes a team
  it('DELETE /admin/teams/:id deletes a team', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });
    mockTeamDelete.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });

    const app = buildApp();
    const res = await request(app).delete('/admin/teams/team-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'team-1' });
    expect(mockTeamDelete).toHaveBeenCalledWith({ where: { id: 'team-1' } });
  });

  // Test 11b — DELETE /admin/teams/:id: non-admin returns 403
  it('DELETE /admin/teams/:id returns 403 for non-admin', async () => {
    mockUser = { userId: 'user-2', id: 'user-2', role: 'USER', tenantId: 't-1' };

    const app = buildApp();
    const res = await request(app).delete('/admin/teams/team-1');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockTeamDelete).not.toHaveBeenCalled();
  });

  // Test 11c — DELETE /admin/teams/:id: 404 for a team in another tenant
  it('DELETE /admin/teams/:id returns 404 when team is not in the admin\'s tenant', async () => {
    mockTeamFindFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).delete('/admin/teams/other-tenant-team');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockTeamDelete).not.toHaveBeenCalled();
  });

  // Test 11 — DELETE /admin/teams/:id/members/:userId: removes a membership
  it('DELETE /admin/teams/:id/members/:userId removes a membership', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });
    mockMembershipDeleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await request(app).delete('/admin/teams/team-1/members/user-5');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ teamId: 'team-1', userId: 'user-5' });
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith({ where: { teamId: 'team-1', userId: 'user-5' } });
  });

  // Test 12 — DELETE /admin/teams/:id/members/:userId: membership not found → 404
  it('DELETE /admin/teams/:id/members/:userId returns 404 when the membership does not exist', async () => {
    mockTeamFindFirst.mockResolvedValue({ id: 'team-1', tenantId: 't-1' });
    mockMembershipDeleteMany.mockResolvedValue({ count: 0 });

    const app = buildApp();
    const res = await request(app).delete('/admin/teams/team-1/members/never-a-member');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
