/**
 * Auto Remediation Loop Service
 *
 * Drives a ComparisonTrial's "auto mode": loops analyze -> auto-approve ->
 * apply -> re-audit on a job until no AI-actionable fixes remain, or a
 * round-count / cumulative Gemini $ cost ceiling is hit, or the operator
 * requests a stop. Manual mode (an operator triggering each step by hand via
 * the existing controllers) is completely untouched by this service.
 *
 * Holds a single remediation-cycle lock (source 'auto_loop') for the entire
 * run rather than one lock per round, since triggerAnalysis/applyAll each
 * acquire and release their own short-lived lock and would 409 against each
 * other if driven back-to-back by a background loop -- this service calls
 * the underlying aiAnalysisService/pdfReauditService methods directly
 * instead, bypassing that per-endpoint lock acquisition entirely. Holding
 * one lock for the whole run also naturally blocks any concurrent manual
 * action on the same job (an operator clicking "Apply Fixes" mid-run gets
 * the same 409 as any other cycle conflict) with no new conflict handling
 * needed.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { aiAnalysisService } from './ai-analysis.service';
import { pdfReauditService } from './pdf-reaudit.service';
import { remediationCycleLockService } from './remediation-cycle-lock.service';
import { remediationCycleHistoryService } from './remediation-cycle-history.service';

/** Suggestion type that always requires manual approval, even in auto mode --
 * a wrong decorative classification silently suppresses image content
 * (sets alt="") rather than just producing an imperfect description, and
 * that failure is invisible on re-audit. Kept pending indefinitely; excluded
 * from the convergence check below so it never blocks the loop from ending. */
const ALWAYS_MANUAL_SUGGESTION_TYPE = 'alt-text-decorative';

const AUTO_MODE_ACTOR = 'auto-mode';

export type AutoStopReason = 'converged' | 'round_limit' | 'budget_limit' | 'manual_stop' | 'error';

class AutoRemediationLoopService {
  /**
   * Starts (or resumes) an auto-mode run for the given trial. Intended to be
   * called fire-and-forget from the /auto-mode/start endpoint; all progress
   * and the terminal result are persisted onto the ComparisonTrial row
   * itself (autoStatus/autoStopReason/autoRoundsCompleted/autoCostSpentUsd),
   * which /auto-mode/status reads back.
   */
  async startAutoLoop(trialId: string): Promise<void> {
    const trial = await prisma.comparisonTrial.findUnique({ where: { id: trialId } });
    if (!trial?.ninjaJobId) {
      logger.warn(`[AutoRemediationLoop] Trial ${trialId} not found or has no associated job`);
      return;
    }
    if (trial.mode !== 'auto') {
      logger.warn(`[AutoRemediationLoop] Trial ${trialId} is not in auto mode -- refusing to start`);
      return;
    }

    const jobId = trial.ninjaJobId;
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.warn(`[AutoRemediationLoop] Job ${jobId} not found for trial ${trialId}`);
      return;
    }

    const lock = await remediationCycleLockService.acquireLock(jobId, AUTO_MODE_ACTOR, 'auto_loop');
    if (!lock.acquired) {
      logger.warn(`[AutoRemediationLoop] Could not acquire remediation lock for job ${jobId} -- another cycle is already in progress`);
      return;
    }
    const cycleNumber = lock.cycleNumber!;
    const heartbeat = remediationCycleLockService.startHeartbeat(jobId, cycleNumber);
    const loopStartedAt = new Date();

    // Fresh run -- reset the counters even if a previous run left them
    // populated, so a restarted auto-mode session reports its own totals.
    await prisma.comparisonTrial.update({
      where: { id: trialId },
      data: {
        autoStatus: 'running',
        autoStopReason: null,
        autoStopRequested: false,
        autoRoundsCompleted: 0,
        autoCostSpentUsd: 0,
      },
    });

    let stopReason: AutoStopReason = 'converged';
    let roundsCompleted = 0;
    let costSpentUsd = 0;

    try {
      while (true) {
        const current = await prisma.comparisonTrial.findUnique({ where: { id: trialId } });
        if (!current) {
          stopReason = 'error';
          break;
        }
        // All three checks happen before starting a round, never mid-round --
        // a round is always allowed to finish once started, so a stop
        // request/ceiling never leaves the PDF half-applied.
        if (current.autoStopRequested) {
          stopReason = 'manual_stop';
          break;
        }
        if (roundsCompleted >= current.autoMaxRounds) {
          stopReason = 'round_limit';
          break;
        }
        if (costSpentUsd >= current.autoCostLimitUsd) {
          stopReason = 'budget_limit';
          break;
        }

        await this.runRound(jobId, cycleNumber, job.tenantId);
        roundsCompleted++;

        const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
        const stats = (latestJob?.output as Record<string, unknown> | undefined)?.aiAnalysisStats as
          | { gemini?: { estimatedCostUsd?: number } }
          | undefined;
        costSpentUsd += stats?.gemini?.estimatedCostUsd ?? 0;

        await prisma.comparisonTrial.update({
          where: { id: trialId },
          data: { autoRoundsCompleted: roundsCompleted, autoCostSpentUsd: costSpentUsd },
        });

        const remaining = await prisma.aiAnalysis.count({
          where: {
            jobId,
            applyMode: 'apply-to-pdf',
            status: { in: ['pending', 'approved'] },
            suggestionType: { not: ALWAYS_MANUAL_SUGGESTION_TYPE },
          },
        });
        if (remaining === 0) {
          stopReason = 'converged';
          break;
        }
      }
    } catch (err) {
      stopReason = 'error';
      logger.error(
        `[AutoRemediationLoop] Job ${jobId} (trial ${trialId}) stopped on error after ${roundsCompleted} round(s): ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      remediationCycleLockService.stopHeartbeat(heartbeat);
      await remediationCycleLockService.releaseLock(jobId, cycleNumber);
      await prisma.comparisonTrial.update({
        where: { id: trialId },
        data: { autoStatus: 'stopped', autoStopReason: stopReason, autoStopRequested: false },
      });
      // RemediationCycleEvent has no dedicated rounds/cost columns -- the
      // authoritative numbers live on ComparisonTrial itself (read by
      // GET /auto-mode/status). This is just a marker entry in the same
      // append-only history the manual flow uses, summarized into
      // errorMessage regardless of outcome since that's the only free-text
      // field available on the event.
      await remediationCycleHistoryService.logEvent({
        jobId,
        cycleNumber,
        action: 'auto_loop_summary',
        source: 'auto_loop',
        status: stopReason === 'error' ? 'failed' : 'completed',
        errorMessage: `${roundsCompleted} round(s), $${costSpentUsd.toFixed(4)} spent, stopped: ${stopReason}`,
        triggeredBy: AUTO_MODE_ACTOR,
        startedAt: loopStartedAt,
      });
      logger.info(
        `[AutoRemediationLoop] Job ${jobId} (trial ${trialId}) finished: ${roundsCompleted} round(s), $${costSpentUsd.toFixed(4)} spent, stopped: ${stopReason}`
      );
    }
  }

  /** One analyze -> auto-approve -> apply -> re-audit pass. Throws on a
   * genuine failure in any step -- the caller's loop treats that as a
   * terminal 'error' stop rather than retrying indefinitely. */
  private async runRound(jobId: string, cycleNumber: number, tenantId: string): Promise<void> {
    const roundStartedAt = new Date();
    await aiAnalysisService.analyzeJob(jobId, tenantId);
    await remediationCycleHistoryService.logEvent({
      jobId,
      cycleNumber,
      action: 'ai_analysis',
      source: 'auto_loop',
      status: 'completed',
      triggeredBy: AUTO_MODE_ACTOR,
      startedAt: roundStartedAt,
    });

    await prisma.aiAnalysis.updateMany({
      where: {
        jobId,
        applyMode: 'apply-to-pdf',
        status: 'pending',
        suggestionType: { not: ALWAYS_MANUAL_SUGGESTION_TYPE },
      },
      data: { status: 'approved', approvedBy: AUTO_MODE_ACTOR },
    });

    const result = await aiAnalysisService.applyApprovedSuggestions(jobId, cycleNumber, AUTO_MODE_ACTOR, 'auto_loop');
    if (result.applied === 0 || !result.modifiedBuffer || !result.fileName) {
      return;
    }

    const comparison = await pdfReauditService.reauditAndCompare(jobId, result.modifiedBuffer, result.fileName);
    const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
    const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
    const { resolvedCount, remainingCount, regressionCount, resolutionRate } = comparison.metrics;

    await prisma.job.update({
      where: { id: jobId },
      data: {
        output: {
          ...latestOutput,
          ...(comparison.success && comparison.reauditReport ? { auditReport: comparison.reauditReport } : {}),
          postRemediationStatus: comparison.success ? 'complete' : 'failed',
          postRemediationAudit: {
            runAt: new Date().toISOString(),
            resolved: resolvedCount,
            remaining: remainingCount,
            regressions: regressionCount,
            resolutionRate,
          },
        } as unknown as Prisma.InputJsonObject,
      },
    });

    await remediationCycleHistoryService.logEvent({
      jobId,
      cycleNumber,
      action: 'reaudit',
      source: 'auto_loop',
      status: comparison.success ? 'completed' : 'failed',
      resolvedCount,
      remainingCount,
      regressionCount,
      resolutionRate,
      errorMessage: comparison.success ? undefined : comparison.error,
      triggeredBy: AUTO_MODE_ACTOR,
      startedAt: roundStartedAt,
    });

    if (!comparison.success) {
      throw new Error(comparison.error ?? 'Re-audit failed during auto-remediation round');
    }
  }
}

export const autoRemediationLoopService = new AutoRemediationLoopService();
