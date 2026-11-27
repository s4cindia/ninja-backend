import prisma from '../lib/prisma';
import { isTeamLeaderOfExecutive } from './team-roster';

export interface AuthorizeJobOptions {
  /** ADMIN tenant-wide bypass -- an ADMIN can access any job in their own
   * tenant, not just their own. Omit (or pass a non-ADMIN role) to keep the
   * original strict-owner-only behavior. */
  role?: string;
  tenantId?: string;
  /**
   * Opt-in: also allow a TEAM_LEADER/VIEWER teammate of the job's owner to
   * access it. Read-only routes ONLY -- see authorizeJobForReview vs
   * authorizeJob in authorize-job.middleware.ts. Never set this for a
   * mutating route: TeamReview is an oversight/review capability, not a
   * grant to act on someone else's job.
   */
  allowTeamReview?: boolean;
  /**
   * Opt-in: also allow the job owner's TEAM_LEADER (never a VIEWER) to ACT
   * on the job. Narrow by design -- only for the EPUB-from-certified-PDF
   * actions a Team Leader is responsible for (certify/revoke, release, the
   * per-job EPUB flag + ISBN, and uploading/removing the certification
   * evidence). Every other mutating route keeps strict owner/ADMIN access.
   * See authorizeJobForTeamLeaderAction in authorize-job.middleware.ts.
   */
  allowTeamLeaderAction?: boolean;
}

/**
 * Tiered check, in order: (1) exact owner -- the original, fast common-case
 * path, unchanged; (2) ADMIN tenant-wide bypass; (3) TEAM_LEADER/VIEWER
 * review access to a teammate's job, opt-in via allowTeamReview; (4) the
 * owner's own TEAM_LEADER acting on the job, opt-in via
 * allowTeamLeaderAction. See the RBAC design doc for the full rationale.
 */
export const authorizeJobAccess = async (jobId: string, userId: string, options: AuthorizeJobOptions = {}) => {
  const ownJob = await prisma.job.findFirst({
    where: {
      id: jobId,
      userId: userId
    },
  });
  if (ownJob) return ownJob;

  if (options.role === 'ADMIN' && options.tenantId) {
    const adminJob = await prisma.job.findFirst({
      where: { id: jobId, tenantId: options.tenantId },
    });
    if (adminJob) return adminJob;
  }

  if (options.allowTeamReview && options.tenantId) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: options.tenantId },
    });
    if (job) {
      // Is `userId` a TEAM_LEADER/VIEWER on a team the job's OWNER also
      // belongs to? Many-to-many membership means this has to be a shared-
      // team lookup, not a direct field comparison.
      const teamAccess = await prisma.teamMembership.findFirst({
        where: {
          userId,
          teamRole: { in: ['TEAM_LEADER', 'VIEWER'] },
          team: { members: { some: { userId: job.userId } } },
        },
      });
      if (teamAccess) return job;
    }
  }

  if (options.allowTeamLeaderAction && options.tenantId) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId: options.tenantId },
    });
    if (job && await isTeamLeaderOfExecutive(userId, job.userId)) return job;
  }

  throw new Error('Job not found or access denied');
};

export const authorizeJobAccessOptional = async (jobId: string, userId?: string) => {
  const whereClause: { id: string; userId?: string } = { id: jobId };
  
  if (userId) {
    whereClause.userId = userId;
  }

  const job = await prisma.job.findFirst({
    where: whereClause,
  });
  
  if (!job) {
    throw new Error('Job not found or access denied');
  }
  
  return job;
};
