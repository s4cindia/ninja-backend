/**
 * Remediation Session Service
 *
 * Idle/visibility-aware timing for an operator's Ninja remediation work on
 * a job, mirroring AnnotationSession's start/end shape exactly (see
 * annotation-timesheet.service.ts) — the client-side timer mechanics are
 * proven, so only the event vocabulary changes (issues applied /
 * suggestions accepted-rejected / bulk-apply used, instead of zone
 * decisions).
 *
 * Works for any PDF_ACCESSIBILITY job, not just Comparison Study trials.
 * When a session ends, we opportunistically check whether the job belongs
 * to a ComparisonTrial and, if so, sync the trial's ninjaActiveMs — that's
 * the only place RemediationSession touches the comparison-study concept.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface EndSessionInput {
  activeMs: number;
  idleMs: number;
  issuesApplied: number;
  suggestionsAccepted: number;
  suggestionsRejected: number;
  bulkApplyUsed: boolean;
  sessionLog?: unknown;
}

class RemediationSessionService {
  async startSession(jobId: string, operatorId: string): Promise<string> {
    const session = await prisma.remediationSession.create({
      data: {
        jobId,
        operatorId,
        startedAt: new Date(),
      },
    });
    return session.id;
  }

  async endSession(sessionId: string, data: EndSessionInput): Promise<void> {
    const session = await prisma.remediationSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        activeMs: data.activeMs,
        idleMs: data.idleMs,
        issuesApplied: data.issuesApplied,
        suggestionsAccepted: data.suggestionsAccepted,
        suggestionsRejected: data.suggestionsRejected,
        bulkApplyUsed: data.bulkApplyUsed,
        sessionLog: (data.sessionLog as object) ?? undefined,
      },
    });

    await this.syncTrialActiveMs(session.jobId);
  }

  /**
   * If this job is a Comparison Study trial's Ninja side, sum all of the
   * job's RemediationSession.activeMs back onto the trial. Best-effort —
   * a failure here should never break session-ending for ordinary jobs.
   */
  private async syncTrialActiveMs(jobId: string): Promise<void> {
    try {
      const trial = await prisma.comparisonTrial.findUnique({
        where: { ninjaJobId: jobId },
        select: { id: true },
      });
      if (!trial) return;

      const agg = await prisma.remediationSession.aggregate({
        where: { jobId },
        _sum: { activeMs: true },
      });

      await prisma.comparisonTrial.update({
        where: { id: trial.id },
        data: { ninjaActiveMs: agg._sum.activeMs ?? 0 },
      });
    } catch (err) {
      logger.warn(`[RemediationSession] Failed to sync trial activeMs for job ${jobId}: ${(err as Error).message}`);
    }
  }
}

export const remediationSessionService = new RemediationSessionService();
