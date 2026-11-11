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
import { authorizeJob, authorizeJobForReview } from '../middleware/authorize-job.middleware';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { notificationService } from '../services/notification/notification.service';

const router = Router();

const teamReviewBodySchema = z.object({
  outcome: z.enum(['OK', 'NEEDS_CORRECTION']),
  notes: z.string().optional(),
});

const requestReviewBodySchema = z.object({
  notes: z.string().optional(),
});

function jobLink(job: { id: string; type: string }): string {
  return job.type === 'EPUB_ACCESSIBILITY' ? `/epub/remediate/${job.id}` : `/pdf/audit/${job.id}`;
}

function jobFileName(job: { input: unknown }): string {
  const input = job.input as { fileName?: string } | null;
  return input?.fileName || 'document';
}

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

    if (parsed.data.outcome === 'NEEDS_CORRECTION') {
      const fileName = jobFileName(job);
      notificationService.createNotification({
        userId: job.userId,
        tenantId: job.tenantId,
        type: 'TEAM_REVIEW_NEEDS_CORRECTION',
        title: 'QC flagged this job for correction',
        message: `"${fileName}" was reviewed and flagged as needing correction${parsed.data.notes ? `: ${parsed.data.notes}` : '.'} It's now blocked from shipment until a follow-up review clears it.`,
        data: { jobId: job.id, reviewId: review.id },
        link: jobLink(job),
      }).catch((notifyErr) => {
        logger.error(`[TeamReview] Failed to create NEEDS_CORRECTION notification for job ${job.id}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
      });
    }

    return res.status(201).json({ success: true, data: review });
  } catch (err) {
    logger.error('POST /jobs/:jobId/team-review error:', err);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  }
});

// POST /api/v1/jobs/:jobId/team-review/request-review
// The owning Executive asks the team's QC for another look (typically after
// addressing a NEEDS_CORRECTION). Owner/ADMIN only -- it's a notification
// nudge, not a write to TeamReview itself, so it leaves no audit row.
router.post('/:jobId/team-review/request-review', authenticate, authorizeJob, async (req: Request, res: Response) => {
  try {
    const job = req.job!;
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const parsed = requestReviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const teamLeaders = await prisma.teamMembership.findMany({
      where: {
        teamRole: 'TEAM_LEADER',
        team: { members: { some: { userId: job.userId } } },
      },
      select: { userId: true },
    });

    if (teamLeaders.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_TEAM_LEADER', message: "No Team Leader was found for this job's team" },
      });
    }

    const fileName = jobFileName(job);
    const link = jobLink(job);
    await Promise.all(
      teamLeaders.map((tl) =>
        notificationService.createNotification({
          userId: tl.userId,
          tenantId: job.tenantId,
          type: 'TEAM_REVIEW_RESUBMIT_REQUESTED',
          title: 'Re-review requested',
          message: `A re-review was requested for "${fileName}"${parsed.data.notes ? `: ${parsed.data.notes}` : '.'}`,
          data: { jobId: job.id },
          link,
        })
      )
    );

    return res.status(200).json({ success: true, data: { notified: teamLeaders.length } });
  } catch (err) {
    logger.error('POST /jobs/:jobId/team-review/request-review error:', err);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  }
});

export default router;
