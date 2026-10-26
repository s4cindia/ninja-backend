/**
 * RBAC / team activity report (Operational Reports Group 5 -- see
 * OPERATIONAL_REPORTS_DESIGN.md). Pure aggregation over Team/TeamMembership/
 * TeamReview/Job, all fully populated since PRs #668/#673/#707/#724 -- no
 * new schema.
 *
 * Shared by two call sites with different scope:
 *  - GET /admin/reports/team-activity (ADMIN, whole tenant): memberUserIds
 *    omitted.
 *  - GET /jobs/team/review-activity (TEAM_LEADER/VIEWER, self-service):
 *    memberUserIds is the caller's own team's roster, computed the same way
 *    job.controller.ts's listTeamJobs already does.
 */

import prisma from '../../lib/prisma';

export interface TeamActivityReportParams {
  tenantId: string;
  from: Date;
  to: Date;
  /** Omit for tenant-wide (ADMIN); pass the caller's team roster for the
   * self-service TEAM_LEADER/VIEWER view. */
  memberUserIds?: string[];
}

export interface ReviewThroughputEntry {
  reviewerId: string;
  reviewerName: string;
  reviewerEmail: string;
  okCount: number;
  needsCorrectionCount: number;
  total: number;
}

export interface OwnershipEntry {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  inProgressJobs: number;
}

export interface TeamActivityReport {
  period: { from: string; to: string };
  reviewThroughput: ReviewThroughputEntry[];
  ownership: OwnershipEntry[];
}

function userDisplayName(user: { firstName: string | null; lastName: string | null; email: string }): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : user.email;
}

class TeamActivityReportService {
  async getReport(params: TeamActivityReportParams): Promise<TeamActivityReport> {
    const { tenantId, from, to, memberUserIds } = params;

    const reviews = await prisma.teamReview.findMany({
      where: {
        job: { tenantId },
        reviewedAt: { gte: from, lte: to },
        ...(memberUserIds ? { reviewedBy: { in: memberUserIds } } : {}),
      },
      select: {
        reviewedBy: true,
        outcome: true,
        reviewer: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    const reviewByReviewer = new Map<string, ReviewThroughputEntry>();
    for (const review of reviews) {
      const entry =
        reviewByReviewer.get(review.reviewedBy) ??
        ({
          reviewerId: review.reviewedBy,
          reviewerName: userDisplayName(review.reviewer),
          reviewerEmail: review.reviewer.email,
          okCount: 0,
          needsCorrectionCount: 0,
          total: 0,
        } satisfies ReviewThroughputEntry);
      if (review.outcome === 'OK') entry.okCount += 1;
      else entry.needsCorrectionCount += 1;
      entry.total += 1;
      reviewByReviewer.set(review.reviewedBy, entry);
    }

    const jobs = await prisma.job.findMany({
      where: {
        tenantId,
        createdAt: { gte: from, lte: to },
        ...(memberUserIds ? { userId: { in: memberUserIds } } : {}),
      },
      select: {
        userId: true,
        status: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    const ownershipByOwner = new Map<string, OwnershipEntry>();
    for (const job of jobs) {
      const entry =
        ownershipByOwner.get(job.userId) ??
        ({
          ownerId: job.userId,
          ownerName: userDisplayName(job.user),
          ownerEmail: job.user.email,
          totalJobs: 0,
          completedJobs: 0,
          failedJobs: 0,
          inProgressJobs: 0,
        } satisfies OwnershipEntry);
      entry.totalJobs += 1;
      if (job.status === 'COMPLETED') entry.completedJobs += 1;
      else if (job.status === 'FAILED') entry.failedJobs += 1;
      else entry.inProgressJobs += 1;
      ownershipByOwner.set(job.userId, entry);
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      reviewThroughput: Array.from(reviewByReviewer.values()).sort((a, b) => b.total - a.total),
      ownership: Array.from(ownershipByOwner.values()).sort((a, b) => b.totalJobs - a.totalJobs),
    };
  }
}

export const teamActivityReportService = new TeamActivityReportService();
