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
import { remediationCycleLockService, STALE_LOCK_MS } from './remediation-cycle-lock.service';
import { remediationCycleHistoryService } from './remediation-cycle-history.service';

/** Suggestion type that always requires manual approval, even in auto mode --
 * a wrong decorative classification silently suppresses image content
 * (sets alt="") rather than just producing an imperfect description, and
 * that failure is invisible on re-audit. Kept pending indefinitely; excluded
 * from the convergence check below so it never blocks the loop from ending. */
const ALWAYS_MANUAL_SUGGESTION_TYPE = 'alt-text-decorative';

const AUTO_MODE_ACTOR = 'auto-mode';

export type ColorContrastMode = 'guidance-only' | 'disabled' | 'apply-to-pdf';
const VALID_COLOR_CONTRAST_MODES: ReadonlySet<string> = new Set(['guidance-only', 'disabled', 'apply-to-pdf']);

/** ComparisonTrial.autoColorContrastMode is nullable with no default: null
 * means "not explicitly overridden for this trial," which must inherit
 * whatever analyzeJob would already resolve to without a session override
 * (the tenant's own aiRemediation.colorContrastMode setting -- a real,
 * operator-configurable value, see tenant-config.controller.ts -- or the
 * backend default if the tenant hasn't set one either). Returns undefined in
 * that case so the caller omits the override entirely, rather than forcing
 * a value that could silently clobber tenant config. Also treats a stored
 * value outside the three the API actually accepts (only reachable via
 * direct DB tampering, since the PATCH endpoint validates against this same
 * enum) as "not set," for the same reason. */
export function resolveColorContrastMode(raw: string | null): ColorContrastMode | undefined {
  if (raw === null) return undefined;
  return VALID_COLOR_CONTRAST_MODES.has(raw) ? (raw as ColorContrastMode) : undefined;
}

/** A round that applies nothing still counts toward the round/cost ceilings
 * (analyzeJob still runs, still spends tokens) without making any progress --
 * e.g. every approved suggestion this round hit an unhandled suggestionType
 * or a missing value and applyApprovedSuggestions left it sitting at
 * 'approved' rather than resolving it. Left unchecked, the loop would keep
 * re-analyzing and re-approving the same stuck suggestion every round until
 * the round/cost ceiling silently absorbs the blame. Stopping distinctly
 * after this many consecutive no-progress rounds surfaces the real cause. */
const STALL_ROUND_LIMIT = 2;

export type AutoStopReason = 'converged' | 'round_limit' | 'budget_limit' | 'manual_stop' | 'stalled' | 'error';

class AutoRemediationLoopService {
  /**
   * Reconciles a trial whose autoStatus is stuck at 'running' because the
   * process actually driving its loop died without reaching the `finally`
   * block in startAutoLoop below -- e.g. an ECS deployment drained the task
   * mid-round. autoStatus has no staleness recovery of its own; only that
   * `finally` block ever flips it back to 'stopped'. remediationCycleLock
   * Service's own lock (source 'auto_loop', heartbeat every 5 min, stale
   * after 20 -- see remediation-cycle-lock.service.ts) is the one liveness
   * signal a crashed run leaves behind: a genuinely-running loop is still
   * heartbeating it, so if that lock is free or stale, nothing is actually
   * driving this trial anymore and nothing else ever will reconcile it.
   *
   * Safe to call before every start/status/stop request -- a no-op both
   * when the run is genuinely still in progress and when it's already
   * terminal. Reusing the lock's own 20-minute staleness window means
   * detection can lag up to that long after a real crash; that matches the
   * lock's own accepted tradeoff rather than inventing a separate one.
   *
   * Deliberately scoped to ONLY the free/stale case -- an earlier version
   * also reconciled when the lock was actively held by a *different* source
   * (e.g. a manual analyze_job action that had reclaimed the auto-loop's
   * stale lock), reasoning that auto_loop was then provably dead. Codex
   * found that this introduced a worse problem than it solved: a client
   * seeing autoStatus flip to 'stopped' would reasonably start a new run,
   * but that run's own acquireLock would then fail against the *other*
   * source's still-valid lock, silently doing nothing despite the 202
   * response. Leaving autoStatus at 'running' in that situation is
   * cosmetically stale but never actionably wrong -- it corrects itself
   * within the same bounded window once that other operation's own lock
   * releases or goes stale.
   *
   * Two earlier attempts at fencing the free/stale write were both found
   * racy (CodeRabbit/Codex): a plain read-then-write has an application-level
   * gap a concurrent acquireLock can land in, and folding the check into the
   * write's own WHERE clause (a relation filter reading Job) narrows that
   * gap but still doesn't take a row lock on Job -- a concurrent acquireLock
   * (itself a plain UPDATE) isn't blocked by a read-only subquery elsewhere.
   * This version takes a real row lock instead: `SELECT ... FOR UPDATE`
   * inside a transaction (same pattern as pdf-remediation.controller.ts's
   * quick-fix endpoint) blocks any concurrent acquireLock attempt on this
   * job until the transaction commits, so the two can never interleave.
   */
  async reconcileIfOrphaned(trialId: string): Promise<void> {
    const trial = await prisma.comparisonTrial.findUnique({
      where: { id: trialId },
      select: { autoStatus: true, ninjaJobId: true },
    });
    if (trial?.autoStatus !== 'running' || !trial.ninjaJobId) return;
    const jobId = trial.ninjaJobId;

    // Fast-path: skip the transaction entirely when the loop is obviously
    // still alive, avoiding pointless lock contention on the hot path
    // (frequent status polls while a run is healthy).
    const lockStatus = await remediationCycleLockService.getLockStatus(jobId);
    if (lockStatus.inProgress) return;

    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ remediationCycleLockedAt: Date | null }>>`
        SELECT "remediationCycleLockedAt" FROM "Job" WHERE id = ${jobId} FOR UPDATE
      `;
      const lockedAt = rows[0]?.remediationCycleLockedAt ?? null;
      const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
      const stillOrphaned = lockedAt === null || lockedAt < staleThreshold;
      if (!stillOrphaned) return; // a concurrent run acquired it while we were waiting for the row lock

      const result = await tx.comparisonTrial.updateMany({
        where: { id: trialId, autoStatus: 'running' },
        data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false },
      });
      if (result.count > 0) {
        logger.warn(
          `[AutoRemediationLoop] Reconciled orphaned run for trial ${trialId} (job ${jobId}) -- its lock is free/stale, so whatever process was running it must have died without cleaning up (e.g. an ECS deploy mid-round)`
        );
      }
    });
  }

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
    let job;
    let lock;
    try {
      job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) {
        logger.warn(`[AutoRemediationLoop] Job ${jobId} not found for trial ${trialId}`);
        return;
      }

      lock = await remediationCycleLockService.acquireLock(jobId, AUTO_MODE_ACTOR, 'auto_loop');
      if (!lock.acquired) {
        logger.warn(`[AutoRemediationLoop] Could not acquire remediation lock for job ${jobId} -- another cycle is already in progress`);
        return;
      }
    } catch (err) {
      // Nothing has been marked "running" yet at this point (no lock held),
      // so there's no lock to release and no in-progress run to mark as
      // errored -- just log. The /auto-mode/start caller also attaches its
      // own rejection handler as a second line of defense.
      logger.error(
        `[AutoRemediationLoop] Failed to start auto loop for trial ${trialId} (job ${jobId}): ${err instanceof Error ? err.message : String(err)}`
      );
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
    let consecutiveStalls = 0;

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

        const { actionableFound, applied } = await this.runRound(
          jobId,
          cycleNumber,
          job.tenantId,
          resolveColorContrastMode(current.autoColorContrastMode),
        );

        // A fresh analysis pass (against whatever the *previous* round's
        // re-audit just produced, or the original audit on round 1) found
        // nothing left to auto-fix -- this is the real convergence signal.
        // Checking here (right after analyzeJob, before spending a round on
        // apply/reaudit) is deliberate: checking *after* applying this
        // round's own suggestions would always look empty (everything this
        // round found is now resolved) regardless of whether the fresh
        // re-audit it's about to produce still has actionable work the next
        // analysis pass hasn't looked at yet.
        if (actionableFound === 0) {
          stopReason = 'converged';
          break;
        }

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

        // A round that found actionable work but applied none of it still
        // consumed a round and Gemini tokens without making progress (e.g.
        // every candidate hit an unhandled suggestionType or missing value)
        // -- stop distinctly rather than let the round/cost ceiling silently
        // absorb the real cause (see STALL_ROUND_LIMIT's doc comment above).
        if (applied === 0) {
          consecutiveStalls++;
          if (consecutiveStalls >= STALL_ROUND_LIMIT) {
            stopReason = 'stalled';
            break;
          }
        } else {
          consecutiveStalls = 0;
        }
      }
    } catch (err) {
      stopReason = 'error';
      logger.error(
        `[AutoRemediationLoop] Job ${jobId} (trial ${trialId}) stopped on error after ${roundsCompleted} round(s): ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      remediationCycleLockService.stopHeartbeat(heartbeat);
      // Terminal trial state is written BEFORE the lock is released (not
      // after) -- otherwise there's a window where the lock reads as free
      // while autoStatus still says 'running', during which a status/stop
      // request could wrongly think this run was orphaned (reconcileIfOrphaned
      // below), or a brand new run could start and then have ITS OWN
      // 'running' status clobbered by this write landing late (CodeRabbit/
      // Codex finding). Writing first closes both: by the time the lock is
      // actually free, this run's true terminal state is already committed.
      //
      // The write is wrapped in its own try/finally so a failure here (a
      // transient DB error, or the trial being deleted concurrently) still
      // releases the lock -- otherwise, with the heartbeat already stopped,
      // the job would stay locked for the full 20-minute staleness window
      // with nothing left to renew it. If the write does fail, autoStatus
      // is left at 'running' with a now-free lock -- exactly the state
      // reconcileIfOrphaned above exists to detect and correct later.
      try {
        await prisma.comparisonTrial.update({
          where: { id: trialId },
          data: { autoStatus: 'stopped', autoStopReason: stopReason, autoStopRequested: false },
        });
      } finally {
        await remediationCycleLockService.releaseLock(jobId, cycleNumber);
      }
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

  /**
   * One analyze -> [auto-approve -> apply -> re-audit] pass. The apply/
   * reaudit steps are skipped entirely when the fresh analysis finds
   * nothing actionable -- that's the caller's convergence signal, checked
   * via `actionableFound` rather than post-apply state (see the call site's
   * comment for why). Throws on a genuine failure in any step -- the
   * caller's loop treats that as a terminal 'error' stop rather than
   * retrying indefinitely.
   */
  private async runRound(
    jobId: string,
    cycleNumber: number,
    tenantId: string,
    colorContrastModeOverride: ColorContrastMode | undefined,
  ): Promise<{ actionableFound: number; applied: number }> {
    const roundStartedAt = new Date();
    const analysis = await aiAnalysisService.analyzeJob(
      jobId,
      tenantId,
      colorContrastModeOverride !== undefined ? { colorContrastMode: colorContrastModeOverride } : undefined,
    );
    await remediationCycleHistoryService.logEvent({
      jobId,
      cycleNumber,
      action: 'ai_analysis',
      source: 'auto_loop',
      status: 'completed',
      triggeredBy: AUTO_MODE_ACTOR,
      startedAt: roundStartedAt,
    });

    // analyzeJob only touches an AiAnalysis row for an issue it currently
    // produces a suggestion for -- when the *effective* colorContrastMode
    // (analysis.colorContrastMode -- resolved by analyzeJob itself from
    // DEFAULT_CONFIG + tenant settings + this call's own override, so it's
    // accurate even when colorContrastModeOverride above is undefined and
    // the trial is inheriting a tenant-level setting) isn't 'apply-to-pdf',
    // color-contrast issues never go through that path at all this round, so
    // a pending/approved color-contrast-fix row left over from an earlier
    // round (or a manual pass) when the mode *was* 'apply-to-pdf' stays
    // untouched. Left alone, the actionable-count/auto-approve queries below
    // don't discriminate by suggestionType (only alt-text-decorative is
    // excluded), so that stale row would still get auto-approved and applied
    // -- silently overriding an operator switching colorContrastMode away
    // from 'apply-to-pdf', whether by an explicit override or by clearing
    // one back to inheriting a tenant setting that isn't 'apply-to-pdf'
    // either (Codex finding: reconciling against colorContrastModeOverride
    // instead of the resolved effective mode missed exactly this transition).
    const effectiveColorContrastMode = analysis.colorContrastMode;
    if (effectiveColorContrastMode === 'guidance-only') {
      await prisma.aiAnalysis.updateMany({
        where: {
          jobId,
          suggestionType: 'color-contrast-fix',
          applyMode: 'apply-to-pdf',
          status: { in: ['pending', 'approved'] },
        },
        data: { applyMode: 'guidance-only' },
      });
    } else if (effectiveColorContrastMode === 'disabled') {
      // 'disabled' means fully suppressed, not just "not auto-applied" --
      // downgrading to guidance-only would still leave the row visible via
      // GET /pdf/:jobId/ai-analysis and counted toward the guidance-
      // acknowledgment flow, contradicting what "disabled" is supposed to
      // mean. Delete outright instead, matching analyzeJob's own pruning
      // semantics for an issue it no longer produces a suggestion for.
      await prisma.aiAnalysis.deleteMany({
        where: {
          jobId,
          suggestionType: 'color-contrast-fix',
          status: { in: ['pending', 'approved'] },
        },
      });
    }

    // Counts 'pending' AND 'approved' rows, not just this round's fresh
    // 'pending' ones -- a row that got approved and then failed to apply in
    // an earlier round (partial apply failure: some suggestions in that
    // batch succeeded, so the round wasn't a full stall, but this one
    // didn't) stays sitting at 'approved' with nothing forcing it back to
    // 'pending'. Counting updateMany's return value alone would miss it and
    // wrongly report convergence with real unapplied work still pending.
    const actionableFound = await prisma.aiAnalysis.count({
      where: {
        jobId,
        applyMode: 'apply-to-pdf',
        status: { in: ['pending', 'approved'] },
        suggestionType: { not: ALWAYS_MANUAL_SUGGESTION_TYPE },
      },
    });
    if (actionableFound === 0) {
      return { actionableFound: 0, applied: 0 };
    }

    // Only flips 'pending' -> 'approved'; any leftover 'approved' row from a
    // prior round's partial failure is already eligible and picked up by
    // applyApprovedSuggestions below without needing to be re-approved here.
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
      return { actionableFound, applied: result.applied };
    }

    const reauditStartedAt = new Date();
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
      startedAt: reauditStartedAt,
    });

    if (!comparison.success) {
      throw new Error(comparison.error ?? 'Re-audit failed during auto-remediation round');
    }

    return { actionableFound, applied: result.applied };
  }
}

export const autoRemediationLoopService = new AutoRemediationLoopService();
