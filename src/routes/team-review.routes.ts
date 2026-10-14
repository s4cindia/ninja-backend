/**
 * Team Review
 *
 * A Team Leader's read-only spot-check or final certificate review of a job
 * they don't own -- an audit-trail write, never a gate on the owning
 * Executive's finalize flow. Job-type-agnostic (works for a PDF or EPUB job
 * alike), so this is its own router mounted at /jobs rather than living
 * under /pdf or /epub. See the RBAC design doc for the full rationale.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJobForReview } from '../middleware/authorize-job.middleware';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

const router = Router();

const teamReviewBodySchema = z.object({
  outcome: z.enum(['OK', 'NEEDS_CORRECTION']),
  notes: z.string().optional(),
});

// POST /api/v1/jobs/:jobId/team-review
router.post('/:jobId/team-review', authenticate, authorizeJobForReview, async (req: Request, res: Response) => {
  try {
    const job = req.job!;
    const user = (req as Request & { user?: { id?: string; role?: string } }).user;
    const userId = user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    // authorizeJobForReview's allowTeamReview tier grants TEAM_LEADER and
    // VIEWER the same READ access (and the owner/an ADMIN pass through its
    // earlier tiers too) -- but writing a review is a TEAM_LEADER-only
    // action (never a VIEWER's, per TeamReview's own schema doc comment).
    // The middleware's access grant doesn't distinguish write intent from
    // read intent, so a VIEWER-only teammate is rejected explicitly here.
    if (user?.role !== 'ADMIN' && job.userId !== userId) {
      const isTeamLeaderOfOwner = await prisma.teamMembership.findFirst({
        where: {
          userId,
          teamRole: 'TEAM_LEADER',
          team: { members: { some: { userId: job.userId } } },
        },
      });
      if (!isTeamLeaderOfOwner) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only a Team Leader may write a review for this job' },
        });
      }
    }

    const parsed = teamReviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const review = await prisma.teamReview.create({
      data: {
        jobId: job.id,
        reviewedBy: userId,
        outcome: parsed.data.outcome,
        notes: parsed.data.notes,
      },
    });

    return res.status(201).json({ success: true, data: review });
  } catch (err) {
    logger.error('POST /jobs/:jobId/team-review error:', err);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  }
});

export default router;
