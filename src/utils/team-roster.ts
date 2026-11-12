import prisma from '../lib/prisma';
import { AppError } from './app-error';

export interface LedExecutive {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  teamId: string;
  teamName: string;
}

export interface JobOwnerAssignment {
  ownerId: string;
  assignedById: string | null;
  assignedAt: Date | null;
}

/**
 * Every Executive on a team this user leads (teamRole TEAM_LEADER) -- the
 * roster a Team Leader picks an assignee from when uploading a title for a
 * teammate. A Team Leader with no team at all gets an empty list, not an
 * error -- the caller (listTeamExecutives) decides whether that's worth
 * surfacing as a 403. A Team Leader leading more than one team (the schema
 * explicitly anticipates this -- see Team's own doc comment) gets every
 * team's Executives together, each entry carrying its own teamId/teamName
 * so the UI can group/label correctly rather than merging them.
 */
export async function getLedExecutives(teamLeaderUserId: string): Promise<LedExecutive[]> {
  const ledTeams = await prisma.teamMembership.findMany({
    where: { userId: teamLeaderUserId, teamRole: 'TEAM_LEADER' },
    select: { teamId: true },
  });
  if (ledTeams.length === 0) return [];

  const teamIds = ledTeams.map((t) => t.teamId);
  const executiveMemberships = await prisma.teamMembership.findMany({
    where: { teamId: { in: teamIds }, teamRole: 'EXECUTIVE' },
    select: {
      teamId: true,
      team: { select: { name: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  return executiveMemberships.map((m) => ({
    userId: m.user.id,
    firstName: m.user.firstName,
    lastName: m.user.lastName,
    email: m.user.email,
    teamId: m.teamId,
    teamName: m.team.name,
  }));
}

/**
 * True iff `teamLeaderUserId` holds TEAM_LEADER on a team where
 * `executiveUserId` is a member with teamRole EXECUTIVE -- the real
 * authorization check behind "can this caller assign an upload to this
 * person." Mirrors authorizeJobAccess's own allowTeamReview tier shape
 * (src/utils/authorization.ts), just checking EXECUTIVE team membership
 * instead of job ownership.
 */
export async function isTeamLeaderOfExecutive(teamLeaderUserId: string, executiveUserId: string): Promise<boolean> {
  const match = await prisma.teamMembership.findFirst({
    where: {
      userId: teamLeaderUserId,
      teamRole: 'TEAM_LEADER',
      team: { members: { some: { userId: executiveUserId, teamRole: 'EXECUTIVE' } } },
    },
  });
  return !!match;
}

/**
 * Resolves who a newly-created Job should actually be owned by, for the
 * two PDF upload entry points (auditFromBuffer/auditFromFileId in
 * pdf.controller.ts). `assigneeUserId` absent, or equal to the caller's
 * own id, is a normal self-upload -- `assignedById`/`assignedAt` stay
 * null, exactly as every job has always worked. A real, different
 * assignee requires the caller to actually be that person's Team Leader
 * (per isTeamLeaderOfExecutive above) -- declines with a 403 rather than
 * silently falling back to a self-upload, so a bad `assigneeUserId` from
 * a tampered/buggy client request is never misread as "assign to myself."
 */
export async function resolveAssignedOwner(
  callerId: string,
  assigneeUserId: string | undefined | null
): Promise<JobOwnerAssignment> {
  if (!assigneeUserId || assigneeUserId === callerId) {
    return { ownerId: callerId, assignedById: null, assignedAt: null };
  }

  const allowed = await isTeamLeaderOfExecutive(callerId, assigneeUserId);
  if (!allowed) {
    throw AppError.forbidden(
      'You can only assign an upload to an Executive on a team you lead',
      'NOT_TEAM_LEADER_OF_EXECUTIVE'
    );
  }

  return { ownerId: assigneeUserId, assignedById: callerId, assignedAt: new Date() };
}
