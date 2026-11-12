/**
 * AuthService -- focused coverage for the new platform-role/team-role
 * payload shape (login + getCurrentUser), added to back an in-app UI
 * feature that shows a logged-in user both their platform role (ADMIN/
 * OPERATOR/USER/VIEWER) and their team role (TEAM_LEADER/EXECUTIVE/
 * VIEWER) next to their name. No prior test coverage existed for this
 * file at all -- this is intentionally scoped to just the new behavior,
 * not a full first-time test of register/login/refreshToken/getCurrentUser
 * end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authService } from '../../../src/services/auth.service';
import prisma from '../../../src/lib/prisma';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'signed-token') },
}));

vi.mock('../../../src/config', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtRefreshSecret: 'test-refresh-secret',
    jwtExpiresIn: '1h',
  },
}));

const basePrismaUser = {
  id: 'user-1',
  email: 'operator@example.com',
  password: 'hashed-password',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'OPERATOR',
  tenantId: 'tenant-1',
  deletedAt: null,
};

describe('AuthService', () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(bcrypt.compare).mockReset();
    vi.mocked(jwt.sign).mockClear();
  });

  describe('login', () => {
    it('includes the team memberships (teamRole + team name) on the returned user', async () => {
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...basePrismaUser,
        teamMemberships: [
          { teamRole: 'TEAM_LEADER', team: { id: 'team-1', name: 'Cell A' } },
        ],
      });

      const result = await authService.login({ email: basePrismaUser.email, password: 'whatever' });

      expect(result.user.teamMemberships).toEqual([
        { teamRole: 'TEAM_LEADER', team: { id: 'team-1', name: 'Cell A' } },
      ]);
      expect(result.user.role).toBe('OPERATOR');
    });

    it('returns an empty teamMemberships array for a user with no team at all', async () => {
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...basePrismaUser,
        teamMemberships: [],
      });

      const result = await authService.login({ email: basePrismaUser.email, password: 'whatever' });

      expect(result.user.teamMemberships).toEqual([]);
    });
  });

  describe('getCurrentUser', () => {
    it('includes the team memberships (teamRole + team name) alongside platform role', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'user-1',
        email: 'admin@example.com',
        firstName: 'Grace',
        lastName: 'Hopper',
        role: 'ADMIN',
        tenantId: 'tenant-1',
        tenant: { id: 'tenant-1', name: 'S4 Carlisle', slug: 's4-carlisle' },
        teamMemberships: [
          { teamRole: 'EXECUTIVE', team: { id: 'team-2', name: 'Cell B' } },
        ],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      const result = await authService.getCurrentUser('user-1');

      expect(result.role).toBe('ADMIN');
      expect(result.teamMemberships).toEqual([
        { teamRole: 'EXECUTIVE', team: { id: 'team-2', name: 'Cell B' } },
      ]);
    });

    it('returns an empty teamMemberships array for a user with no team at all', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'user-1',
        email: 'solo@example.com',
        firstName: 'Lone',
        lastName: 'Operator',
        role: 'USER',
        tenantId: 'tenant-1',
        tenant: { id: 'tenant-1', name: 'S4 Carlisle', slug: 's4-carlisle' },
        teamMemberships: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      const result = await authService.getCurrentUser('user-1');

      expect(result.teamMemberships).toEqual([]);
    });
  });
});
