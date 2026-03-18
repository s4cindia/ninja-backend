import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// --- Prisma mock ---
const mockUserFindUnique = vi.fn();
const mockUserFindMany = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      findMany: (...args: unknown[]) => mockUserFindMany(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
  },
}));

// --- bcryptjs mock ---
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$12$hashedpassword'),
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

import adminUsersRoutes from '../../../../src/routes/admin/users.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminUsersRoutes);
  return app;
}

describe('admin/users.routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      userId: 'admin-1', id: 'admin-1',
      role: 'ADMIN', tenantId: 't-1', email: 'admin@test.com',
    };
  });

  // Test 1 — POST /admin/users: creates OPERATOR account
  it('POST /admin/users creates operator account', async () => {
    mockUserFindUnique.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({
      id: 'user-new',
      email: 'operator@test.com',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'OPERATOR',
      createdAt: new Date('2026-03-19'),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/users')
      .send({
        email: 'operator@test.com',
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'OPERATOR',
        password: 'securepass123',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('user-new');
    expect(res.body.data.role).toBe('OPERATOR');
    expect(res.body.data).not.toHaveProperty('password');
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          password: '$2a$12$hashedpassword',
          tenantId: 't-1',
        }),
      }),
    );
  });

  // Test 2 — POST /admin/users: 409 for duplicate email
  it('POST /admin/users returns 409 for duplicate email', async () => {
    mockUserFindUnique.mockResolvedValue({ id: 'existing', email: 'dup@test.com' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/users')
      .send({
        email: 'dup@test.com',
        firstName: 'Jane',
        lastName: 'Doe',
        password: 'securepass123',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });

  // Test 3 — POST /admin/users: non-admin returns 403
  it('POST /admin/users returns 403 for non-admin', async () => {
    mockUser = { userId: 'user-2', id: 'user-2', role: 'USER', tenantId: 't-1' };

    const app = buildApp();
    const res = await request(app)
      .post('/admin/users')
      .send({
        email: 'new@test.com',
        firstName: 'Jane',
        lastName: 'Doe',
        password: 'securepass123',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // Test 4 — POST /admin/users: invalid email → 422
  it('POST /admin/users returns 422 for invalid email', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/users')
      .send({
        email: 'not-an-email',
        firstName: 'Jane',
        lastName: 'Doe',
        password: 'securepass123',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // Test 5 — POST /admin/users: short password → 422
  it('POST /admin/users returns 422 for short password', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/users')
      .send({
        email: 'valid@test.com',
        firstName: 'Jane',
        lastName: 'Doe',
        password: 'short',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // Test 6 — GET /admin/users: returns list without passwords
  it('GET /admin/users returns user list', async () => {
    mockUserFindMany.mockResolvedValue([
      { id: 'u1', email: 'a@t.com', firstName: 'A', lastName: 'B', role: 'OPERATOR', createdAt: new Date(), tenantId: 't-1' },
      { id: 'u2', email: 'b@t.com', firstName: 'C', lastName: 'D', role: 'USER', createdAt: new Date(), tenantId: 't-1' },
    ]);

    const app = buildApp();
    const res = await request(app).get('/admin/users');

    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(2);
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ password: true }),
      }),
    );
  });

  // Test 7 — GET /admin/users?role=OPERATOR: filtered
  it('GET /admin/users filters by role', async () => {
    mockUserFindMany.mockResolvedValue([]);

    const app = buildApp();
    await request(app).get('/admin/users?role=OPERATOR');

    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: 'OPERATOR' },
      }),
    );
  });

  // Test 8 — PATCH /admin/users/:id/role: updates role
  it('PATCH /admin/users/:id/role updates role', async () => {
    mockUserUpdate.mockResolvedValue({ id: 'user-2', role: 'OPERATOR' });

    const app = buildApp();
    const res = await request(app)
      .patch('/admin/users/user-2/role')
      .send({ role: 'OPERATOR' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('user-2');
    expect(res.body.data.role).toBe('OPERATOR');
  });

  // Test 9 — PATCH: self-role-change returns 400
  it('PATCH /admin/users/:id/role returns 400 for self-change', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/admin/users/admin-1/role')
      .send({ role: 'USER' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_ROLE_CHANGE');
  });

  // Test 10 — PATCH: unknown user returns 404
  it('PATCH /admin/users/:id/role returns 404 for unknown user', async () => {
    const prismaError = new Error('Record not found');
    (prismaError as unknown as { code: string }).code = 'P2025';
    mockUserUpdate.mockRejectedValue(prismaError);

    const app = buildApp();
    const res = await request(app)
      .patch('/admin/users/missing-id/role')
      .send({ role: 'OPERATOR' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
