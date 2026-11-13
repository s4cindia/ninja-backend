/**
 * team-roster.ts -- the real authorization/roster logic behind "a Team
 * Leader uploads a PDF and assigns it directly to one of their own
 * Executives." getLedExecutives/isTeamLeaderOfExecutive/
 * resolveAssignedOwner are each used by both pdf.controller.ts's upload
 * paths and job.controller.ts's new roster endpoint, so this is the one
 * place their correctness actually needs to be pinned down.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    teamMembership: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

import prisma from '../../../src/lib/prisma';
import { getLedExecutives, isTeamLeaderOfExecutive, resolveAssignedOwner } from '../../../src/utils/team-roster';

describe('team-roster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getLedExecutives', () => {
    it('returns an empty list for a user who leads no team at all, without querying for Executives', async () => {
      (prisma.teamMembership.findMany as any).mockResolvedValueOnce([]);

      const result = await getLedExecutives('exec-1');

      expect(result).toEqual([]);
      expect(prisma.teamMembership.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns every Executive across every team this user leads, each tagged with its own team', async () => {
      (prisma.teamMembership.findMany as any)
        .mockResolvedValueOnce([{ teamId: 'team-1' }, { teamId: 'team-2' }])
        .mockResolvedValueOnce([
          { teamId: 'team-1', team: { name: 'Cell A' }, user: { id: 'exec-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } },
          { teamId: 'team-2', team: { name: 'Cell B' }, user: { id: 'exec-2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' } },
        ]);

      const result = await getLedExecutives('leader-1');

      expect(result).toEqual([
        { userId: 'exec-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', teamId: 'team-1', teamName: 'Cell A' },
        { userId: 'exec-2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', teamId: 'team-2', teamName: 'Cell B' },
      ]);
      expect(prisma.teamMembership.findMany).toHaveBeenNthCalledWith(2, {
        where: { teamId: { in: ['team-1', 'team-2'] }, teamRole: 'EXECUTIVE' },
        select: expect.any(Object),
      });
    });

    it('only resolves teams where the caller is specifically TEAM_LEADER, not VIEWER', async () => {
      (prisma.teamMembership.findMany as any).mockResolvedValueOnce([]);

      await getLedExecutives('viewer-1');

      expect(prisma.teamMembership.findMany).toHaveBeenCalledWith({
        where: { userId: 'viewer-1', teamRole: 'TEAM_LEADER' },
        select: { teamId: true },
      });
    });
  });

  describe('isTeamLeaderOfExecutive', () => {
    it('returns true when the caller leads a team the given user is an Executive on', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce({ id: 'membership-1' });

      const result = await isTeamLeaderOfExecutive('leader-1', 'exec-1');

      expect(result).toBe(true);
      expect(prisma.teamMembership.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'leader-1',
          teamRole: 'TEAM_LEADER',
          team: { members: { some: { userId: 'exec-1', teamRole: 'EXECUTIVE' } } },
        },
      });
    });

    it('returns false when no such relationship exists', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce(null);

      const result = await isTeamLeaderOfExecutive('leader-1', 'stranger-1');

      expect(result).toBe(false);
    });
  });

  describe('resolveAssignedOwner', () => {
    it('is a normal self-upload passthrough when no assigneeUserId is given at all', async () => {
      const result = await resolveAssignedOwner('caller-1', undefined);

      expect(result).toEqual({ ownerId: 'caller-1', assignedById: null, assignedAt: null });
      expect(prisma.teamMembership.findFirst).not.toHaveBeenCalled();
    });

    it('is a normal self-upload passthrough when assigneeUserId equals the caller\'s own id', async () => {
      const result = await resolveAssignedOwner('caller-1', 'caller-1');

      expect(result).toEqual({ ownerId: 'caller-1', assignedById: null, assignedAt: null });
      expect(prisma.teamMembership.findFirst).not.toHaveBeenCalled();
    });

    it('resolves to the assignee as owner, stamping who assigned it and when, for a valid Team-Leader-to-Executive assignment', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce({ id: 'membership-1' });

      const before = new Date();
      const result = await resolveAssignedOwner('leader-1', 'exec-1');
      const after = new Date();

      expect(result.ownerId).toBe('exec-1');
      expect(result.assignedById).toBe('leader-1');
      expect(result.assignedAt).toBeInstanceOf(Date);
      expect(result.assignedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.assignedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('declines with a 403 AppError rather than silently falling back to a self-upload, for an invalid assignment', async () => {
      (prisma.teamMembership.findFirst as any).mockResolvedValueOnce(null);

      await expect(resolveAssignedOwner('not-a-leader', 'exec-1')).rejects.toMatchObject({
        statusCode: 403,
        code: 'NOT_TEAM_LEADER_OF_EXECUTIVE',
      });
    });
  });
});
