import prisma from '../../lib/prisma';

export interface ReviewBlock {
  reviewId: string;
  reviewedBy: string;
  reviewedAt: Date;
  notes: string | null;
}

/**
 * The most recent TeamReview for a job gates whether it may ship
 * (downloaded/exported). Only an explicit NEEDS_CORRECTION blocks -- a job
 * with no review yet, or whose latest review is OK, returns null and ships
 * normally. A later OK review supersedes an earlier NEEDS_CORRECTION since
 * this always looks at the single most recent row.
 */
export async function getActiveReviewBlock(jobId: string): Promise<ReviewBlock | null> {
  const latest = await prisma.teamReview.findFirst({
    where: { jobId },
    orderBy: { reviewedAt: 'desc' },
  });

  if (!latest || latest.outcome !== 'NEEDS_CORRECTION') {
    return null;
  }

  return {
    reviewId: latest.id,
    reviewedBy: latest.reviewedBy,
    reviewedAt: latest.reviewedAt,
    notes: latest.notes,
  };
}
