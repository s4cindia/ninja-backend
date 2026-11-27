/**
 * Tier 4 of authorizeJobAccess (allowTeamLeaderAction) and the
 * authorizeJobForTeamLeaderAction middleware: the owner's own TEAM_LEADER
 * may act on the job, for the EPUB-from-certified-PDF routes only. A
 * VIEWER, a Team Leader of another team, or anyone in another tenant must
 * not get through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn() },
    teamMembership: { findFirst: vi.fn() },
  },
}));

import prisma from '../../../src/lib/prisma';
import { authorizeJobAccess } from '../../../src/utils/authorization';
import { authorizeJobForTeamLeaderAction } from '../../../src/middleware/authorize-job.middleware';

const findJob = vi.mocked(prisma.job.findFirst);
const findMembership = vi.mocked(prisma.teamMembership.findFirst);

const JOB = { id: 'job-1', userId: 'exec-1', tenantId: 'tenant-1', type: 'PDF_ACCESSIBILITY' };

/**
 * Team data: 'leader-1' leads a team whose EXECUTIVE is exec-1;
 * 'viewer-1' is a VIEWER on that team; 'leader-2' leads a different team.
 * Answers isTeamLeaderOfExecutive's real query shape.
 */
function teamsAre() {
  findMembership.mockImplementation((async (args: {
    where: { userId: string; teamRole: string; team: { members: { some: { userId: string; teamRole: string } } } };
  }) => {
    const { userId, teamRole, team } = args.where;
    const exec = team.members.some;
    const isLeaderOfExec1 = userId === 'leader-1' && teamRole === 'TEAM_LEADER'
      && exec.userId === 'exec-1' && exec.teamRole === 'EXECUTIVE';
    return isLeaderOfExec1 ? { id: 'm1' } : null;
  }) as never);
}

beforeEach(() => {
  findJob.mockReset();
  findMembership.mockReset();
  teamsAre();
  // Tier 1 (owner) lookup has a userId filter; tier 4 is tenant-scoped only.
  findJob.mockImplementation((async (args: { where: { id: string; userId?: string; tenantId?: string } }) => {
    const { where } = args;
    if (where.id !== 'job-1') return null;
    if (where.userId !== undefined) return where.userId === JOB.userId ? JOB : null;
    if (where.tenantId !== undefined) return where.tenantId === JOB.tenantId ? JOB : null;
    return null;
  }) as never);
});

describe('authorizeJobAccess with allowTeamLeaderAction', () => {
  it("grants the owner's Team Leader", async () => {
    await expect(
      authorizeJobAccess('job-1', 'leader-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).resolves.toEqual(JOB);
  });

  it('still grants the owner without any team lookup', async () => {
    await expect(
      authorizeJobAccess('job-1', 'exec-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).resolves.toEqual(JOB);
    expect(findMembership).not.toHaveBeenCalled();
  });

  it('refuses a VIEWER on the same team', async () => {
    await expect(
      authorizeJobAccess('job-1', 'viewer-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).rejects.toThrow('access denied');
  });

  it('refuses a Team Leader of a different team', async () => {
    await expect(
      authorizeJobAccess('job-1', 'leader-2', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).rejects.toThrow('access denied');
  });

  it('refuses across tenants without consulting team membership', async () => {
    await expect(
      authorizeJobAccess('job-1', 'leader-1', { tenantId: 'tenant-2', allowTeamLeaderAction: true }),
    ).rejects.toThrow('access denied');
    expect(findMembership).not.toHaveBeenCalled();
  });

  it('is off by default: a Team Leader cannot act through plain authorizeJob access', async () => {
    await expect(authorizeJobAccess('job-1', 'leader-1', { tenantId: 'tenant-1' })).rejects.toThrow('access denied');
    expect(findMembership).not.toHaveBeenCalled();
  });
});

/**
 * The Team-Leader-uploads-and-assigns case, end to end through the real
 * resolveAssignedOwner: the job's owner (userId) must be the assigned
 * Executive -- not the uploading Team Leader -- so the Executive passes as
 * owner, and the Team Leader passes the TL tier tested against that
 * Executive (not against themselves).
 */
describe('Team Leader uploads and assigns to an Executive', () => {
  async function jobFromUpload(callerId: string, assigneeUserId: string | null) {
    const { resolveAssignedOwner } = await import('../../../src/utils/team-roster');
    const assignment = await resolveAssignedOwner(callerId, assigneeUserId);
    // Same fields both PDF upload paths write (pdf.controller.ts).
    const job = {
      id: 'job-1', tenantId: 'tenant-1', type: 'PDF_ACCESSIBILITY',
      userId: assignment.ownerId, assignedById: assignment.assignedById,
    };
    findJob.mockImplementation((async (args: { where: { id: string; userId?: string; tenantId?: string } }) => {
      const { where } = args;
      if (where.id !== job.id) return null;
      if (where.userId !== undefined) return where.userId === job.userId ? job : null;
      if (where.tenantId !== undefined) return where.tenantId === job.tenantId ? job : null;
      return null;
    }) as never);
    return job;
  }

  it('makes the assigned Executive the owner, recording the Team Leader only as assignedById', async () => {
    const job = await jobFromUpload('leader-1', 'exec-1');
    expect(job.userId).toBe('exec-1');
    expect(job.assignedById).toBe('leader-1');
  });

  it('lets the assigned Executive act as owner (no team lookup needed)', async () => {
    await jobFromUpload('leader-1', 'exec-1');
    findMembership.mockClear();
    await expect(
      authorizeJobAccess('job-1', 'exec-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).resolves.toMatchObject({ userId: 'exec-1' });
    expect(findMembership).not.toHaveBeenCalled();
  });

  it('lets the uploading Team Leader act, tested as TL of the assigned Executive', async () => {
    await jobFromUpload('leader-1', 'exec-1');
    findMembership.mockClear();

    await expect(
      authorizeJobAccess('job-1', 'leader-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).resolves.toMatchObject({ userId: 'exec-1', assignedById: 'leader-1' });

    // The TL check ran against the Executive, not the Team Leader themselves.
    expect(findMembership).toHaveBeenCalledWith({
      where: {
        userId: 'leader-1',
        teamRole: 'TEAM_LEADER',
        team: { members: { some: { userId: 'exec-1', teamRole: 'EXECUTIVE' } } },
      },
    });
  });

  it('refuses a VIEWER on the same team, and another team\'s leader, on an assigned job', async () => {
    await jobFromUpload('leader-1', 'exec-1');
    for (const user of ['viewer-1', 'leader-2']) {
      await expect(
        authorizeJobAccess('job-1', user, { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
      ).rejects.toThrow('access denied');
    }
  });

  it('refuses the assignment itself when the uploader does not lead the Executive', async () => {
    const { resolveAssignedOwner } = await import('../../../src/utils/team-roster');
    await expect(resolveAssignedOwner('leader-2', 'exec-1')).rejects.toMatchObject({
      statusCode: 403, code: 'NOT_TEAM_LEADER_OF_EXECUTIVE',
    });
  });

  it('a Team Leader self-upload (no assignee) is owned by the Team Leader', async () => {
    const job = await jobFromUpload('leader-1', null);
    expect(job).toMatchObject({ userId: 'leader-1', assignedById: null });
    await expect(
      authorizeJobAccess('job-1', 'leader-1', { tenantId: 'tenant-1', allowTeamLeaderAction: true }),
    ).resolves.toMatchObject({ userId: 'leader-1' });
  });
});

describe('authorizeJobForTeamLeaderAction middleware', () => {
  function run(user: Record<string, string> | undefined, jobId = 'job-1') {
    const req = { params: { jobId }, user } as unknown as Request;
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
    (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
    const next = vi.fn() as unknown as NextFunction;
    return { req, res, next, done: authorizeJobForTeamLeaderAction(req, res, next) };
  }

  it("lets the owner's Team Leader through and attaches req.job", async () => {
    const { req, next, done } = run({ id: 'leader-1', tenantId: 'tenant-1', role: 'USER' });
    await done;
    expect(next).toHaveBeenCalledWith();
    expect(req.job).toEqual(JOB);
  });

  it('answers 404 (not 403) for a VIEWER, revealing nothing', async () => {
    const { res, next, done } = run({ id: 'viewer-1', tenantId: 'tenant-1', role: 'USER' });
    await done;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('answers 401 without a user', async () => {
    const { res, done } = run(undefined);
    await done;
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
