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
import { fileStorageService } from '../storage/file-storage.service';
import { notificationService } from '../notification/notification.service';
import type { NotificationType } from '@prisma/client';

/** Suggestion type that always requires manual approval, even in auto mode --
 * a wrong decorative classification silently suppresses image content
 * (sets alt="") rather than just producing an imperfect description, and
 * that failure is invisible on re-audit. Kept pending indefinitely; excluded
 * from the convergence check below so it never blocks the loop from ending. */
const ALWAYS_MANUAL_SUGGESTION_TYPE = 'alt-text-decorative';

const AUTO_MODE_ACTOR = 'auto-mode';

/** How many consecutive crash-recoveries (reconcileIfOrphaned/
 *  reconcileIfOrphanedJobRun finding a genuinely dead run) within
 *  CRASH_RECOVERY_LOOKBACK_MS get an automatic resume from maybeAutoResume
 *  below before giving up and leaving the run for manual review -- caps the
 *  blast radius of a document that dies (OOM or otherwise) on every
 *  attempt, so it can't be auto-resumed forever. */
const MAX_AUTO_CRASH_RESUMES = 2;
/** Rolling window maybeAutoResume counts recent 'orphan_reconciled' history
 *  events in. Deliberately not tied to the run's own autoStartedAt, which
 *  resets on every resume (see resetForNewRun) and would otherwise make
 *  each resume forget the crashes that came before it. */
const CRASH_RECOVERY_LOOKBACK_MS = 60 * 60 * 1000;

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

/**
 * Maps a terminal AutoStopReason to the operator notification it deserves.
 * 'converged' is a genuine success (nothing left to auto-fix); the two
 * ceilings and 'stalled' are each a real decision point (continue with a
 * higher limit, or move to manual review) rather than a failure, hence
 * SYSTEM_ALERT rather than JOB_FAILED; 'error' is the one case that's
 * actually broken. 'manual_stop' never reaches here -- the caller skips it
 * entirely (see startAutoLoop's own finally block).
 */
export function describeAutoLoopStop(
  stopReason: Exclude<AutoStopReason, 'manual_stop'>,
  docLabel: string,
  roundsCompleted: number,
  costSpentUsd: number,
  errorMessage: string | undefined,
): { type: NotificationType; title: string; message: string } {
  const spent = `$${costSpentUsd.toFixed(2)}`;
  const rounds = `${roundsCompleted} round${roundsCompleted === 1 ? '' : 's'}`;
  switch (stopReason) {
    case 'converged':
      return {
        type: 'JOB_COMPLETED',
        title: 'Auto Mode finished',
        message: `${docLabel} converged after ${rounds} (${spent} spent) -- nothing left to fix automatically. Ready for your review.`,
      };
    case 'round_limit':
      return {
        type: 'SYSTEM_ALERT',
        title: 'Auto Mode paused -- round limit reached',
        message: `${docLabel} hit its round limit after ${rounds} (${spent} spent), with more actionable work still found. Start another round or review progress so far.`,
      };
    case 'budget_limit':
      return {
        type: 'SYSTEM_ALERT',
        title: 'Auto Mode paused -- budget limit reached',
        message: `${docLabel} hit its cost limit after ${rounds} (${spent} spent), with more actionable work still found. Raise the budget or review progress so far.`,
      };
    case 'stalled':
      return {
        type: 'SYSTEM_ALERT',
        title: 'Auto Mode paused -- no further progress',
        message: `${docLabel} stopped after ${rounds} (${spent} spent): the last few rounds made no measurable progress. Review what's left manually.`,
      };
    case 'error':
      return {
        type: 'JOB_FAILED',
        title: 'Auto Mode stopped on error',
        message: errorMessage
          ? `${docLabel} stopped after ${rounds} (${spent} spent): ${errorMessage}`
          : `${docLabel} stopped after ${rounds} (${spent} spent) due to an unexpected error.`,
      };
  }
}

/**
 * Driver abstraction for startAutoLoop -- lets the SAME loop body (below)
 * persist its state to either ComparisonTrial (an admin-created Comparison
 * Study trial) or PdfAutoRemediationRun (any job the caller owns, via
 * POST /pdf/:jobId/auto-mode/start) without either becoming a dependency of
 * the other. Extracted from what used to be startAutoLoop's own direct
 * prisma.comparisonTrial.* calls -- see ComparisonTrialAutoRemediationDriver
 * below for the zero-behavior-change wrapper of that exact logic.
 *
 * Deliberately does NOT cover reconcileIfOrphaned/reconcileIfOrphanedJobRun
 * above: both are controller-level plumbing (pdf-auto-mode.controller.ts's
 * start/status/stop handlers call the matching one before treating an
 * existing 'running' row as authoritative), not part of the loop body
 * itself. Both trial and job-run paths go through the exact same
 * reconcile-on-read pattern today -- there is no separate scheduler.
 */
export interface AutoRemediationConfig {
  jobId: string;
  tenantId: string;
}

export interface AutoRemediationRoundState {
  autoStopRequested: boolean;
  autoMaxRounds: number;
  autoCostLimitUsd: number;
  autoColorContrastMode: string | null;
}

export interface AutoRemediationDriver {
  /** Short label for log lines (e.g. `trial abc123`). Not a behavioral
   *  contract -- callers should not parse this string. */
  describe(): string;
  /** Resolves the job/tenant this run targets, and whether it's eligible to
   *  start at all (e.g. ComparisonTrial.mode === 'auto'). Null means refuse
   *  to start: the caller logs a warning and returns without acquiring a
   *  lock or marking anything running. */
  getConfig(): Promise<AutoRemediationConfig | null>;
  /** Fresh-run reset, called once after the lock is acquired and before the
   *  loop begins -- resets round/cost counters and records the start time,
   *  even over a previous run's leftover values. */
  resetForNewRun(startedAt: Date): Promise<void>;
  /** Re-reads the current per-round control values -- called once per loop
   *  iteration, before running a round (never mid-round). Null means the
   *  underlying record disappeared (e.g. deleted mid-run); the caller stops
   *  with 'error'. */
  getRoundState(): Promise<AutoRemediationRoundState | null>;
  /** Persists round progress after each completed round. */
  recordRoundProgress(roundsCompleted: number, costSpentUsd: number): Promise<void>;
  /** Terminal write, called from the loop's finally block (before the
   *  remediation-cycle lock is released -- see startAutoLoop's own comment
   *  on why that ordering matters). */
  markStopped(stopReason: AutoStopReason, stoppedAt: Date): Promise<void>;
}

/**
 * Wraps the exact prisma.comparisonTrial.* calls startAutoLoop used to make
 * directly -- zero behavior change for Comparison Study. Every read/write,
 * in the same order, with the same data, as before this driver existed.
 */
export class ComparisonTrialAutoRemediationDriver implements AutoRemediationDriver {
  constructor(private readonly trialId: string) {}

  describe(): string {
    return `trial ${this.trialId}`;
  }

  async getConfig(): Promise<AutoRemediationConfig | null> {
    const trial = await prisma.comparisonTrial.findUnique({ where: { id: this.trialId } });
    if (!trial?.ninjaJobId || trial.mode !== 'auto') return null;
    const job = await prisma.job.findUnique({ where: { id: trial.ninjaJobId } });
    if (!job) return null;
    return { jobId: trial.ninjaJobId, tenantId: job.tenantId };
  }

  async resetForNewRun(startedAt: Date): Promise<void> {
    await prisma.comparisonTrial.update({
      where: { id: this.trialId },
      data: {
        autoStatus: 'running',
        autoStopReason: null,
        autoStopRequested: false,
        autoRoundsCompleted: 0,
        autoCostSpentUsd: 0,
        autoStartedAt: startedAt,
        autoStoppedAt: null,
      },
    });
  }

  async getRoundState(): Promise<AutoRemediationRoundState | null> {
    const current = await prisma.comparisonTrial.findUnique({ where: { id: this.trialId } });
    if (!current) return null;
    return {
      autoStopRequested: current.autoStopRequested,
      autoMaxRounds: current.autoMaxRounds,
      autoCostLimitUsd: current.autoCostLimitUsd,
      autoColorContrastMode: current.autoColorContrastMode,
    };
  }

  async recordRoundProgress(roundsCompleted: number, costSpentUsd: number): Promise<void> {
    await prisma.comparisonTrial.update({
      where: { id: this.trialId },
      data: { autoRoundsCompleted: roundsCompleted, autoCostSpentUsd: costSpentUsd },
    });
  }

  async markStopped(stopReason: AutoStopReason, stoppedAt: Date): Promise<void> {
    await prisma.comparisonTrial.update({
      where: { id: this.trialId },
      data: { autoStatus: 'stopped', autoStopReason: stopReason, autoStopRequested: false, autoStoppedAt: stoppedAt },
    });
  }
}

/**
 * Backs the loop with `PdfAutoRemediationRun` instead of `ComparisonTrial` --
 * the production, non-trial path (any job, started via
 * POST /pdf/:jobId/auto-mode/start when the job has no ComparisonTrial). This
 * table already existed (added for the batch-processing feature) with the
 * exact same auto-mode field set, just never had a driver written against it.
 *
 * No `mode` gate in getConfig() -- unlike ComparisonTrial, PdfAutoRemediationRun
 * has no `mode` column. The row's existence (created by the controller's own
 * upsert right before calling startAutoLoop) IS the opt-in signal; there's
 * nothing else to check eligibility against.
 */
export class JobAutoRemediationDriver implements AutoRemediationDriver {
  constructor(private readonly runId: string) {}

  describe(): string {
    return `job-run ${this.runId}`;
  }

  async getConfig(): Promise<AutoRemediationConfig | null> {
    const run = await prisma.pdfAutoRemediationRun.findUnique({ where: { id: this.runId } });
    if (!run) return null;
    const job = await prisma.job.findUnique({ where: { id: run.jobId } });
    if (!job) return null;
    return { jobId: run.jobId, tenantId: job.tenantId };
  }

  async resetForNewRun(startedAt: Date): Promise<void> {
    await prisma.pdfAutoRemediationRun.update({
      where: { id: this.runId },
      data: {
        autoStatus: 'running',
        autoStopReason: null,
        autoStopRequested: false,
        autoRoundsCompleted: 0,
        autoCostSpentUsd: 0,
        autoStartedAt: startedAt,
        autoStoppedAt: null,
      },
    });
  }

  async getRoundState(): Promise<AutoRemediationRoundState | null> {
    const current = await prisma.pdfAutoRemediationRun.findUnique({ where: { id: this.runId } });
    if (!current) return null;
    return {
      autoStopRequested: current.autoStopRequested,
      autoMaxRounds: current.autoMaxRounds,
      autoCostLimitUsd: current.autoCostLimitUsd,
      autoColorContrastMode: current.autoColorContrastMode,
    };
  }

  async recordRoundProgress(roundsCompleted: number, costSpentUsd: number): Promise<void> {
    await prisma.pdfAutoRemediationRun.update({
      where: { id: this.runId },
      data: { autoRoundsCompleted: roundsCompleted, autoCostSpentUsd: costSpentUsd },
    });
  }

  async markStopped(stopReason: AutoStopReason, stoppedAt: Date): Promise<void> {
    await prisma.pdfAutoRemediationRun.update({
      where: { id: this.runId },
      data: { autoStatus: 'stopped', autoStopReason: stopReason, autoStopRequested: false, autoStoppedAt: stoppedAt },
    });
  }
}

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
  async reconcileIfOrphaned(trialId: string): Promise<boolean> {
    const trial = await prisma.comparisonTrial.findUnique({
      where: { id: trialId },
      select: { autoStatus: true, ninjaJobId: true, autoRoundsCompleted: true },
    });
    if (trial?.autoStatus !== 'running' || !trial.ninjaJobId) return false;
    const jobId = trial.ninjaJobId;
    const roundsCompletedBeforeReconcile = trial.autoRoundsCompleted;

    // Fast-path: skip the transaction entirely when the loop is obviously
    // still alive, avoiding pointless lock contention on the hot path
    // (frequent status polls while a run is healthy).
    const lockStatus = await remediationCycleLockService.getLockStatus(jobId);
    if (lockStatus.inProgress) return false;

    const reconciled = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ remediationCycleLockedAt: Date | null }>>`
        SELECT "remediationCycleLockedAt" FROM "Job" WHERE id = ${jobId} FOR UPDATE
      `;
      const lockedAt = rows[0]?.remediationCycleLockedAt ?? null;
      const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
      const stillOrphaned = lockedAt === null || lockedAt < staleThreshold;
      if (!stillOrphaned) return false; // a concurrent run acquired it while we were waiting for the row lock

      const result = await tx.comparisonTrial.updateMany({
        where: { id: trialId, autoStatus: 'running' },
        data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: new Date() },
      });
      if (result.count > 0) {
        logger.warn(
          `[AutoRemediationLoop] Reconciled orphaned run for trial ${trialId} (job ${jobId}) -- its lock is free/stale, so whatever process was running it must have died without cleaning up (e.g. an ECS deploy mid-round)`
        );
      }
      return result.count > 0;
    });
    if (reconciled) {
      await this.logInterruption(jobId, roundsCompletedBeforeReconcile + 1, 'orphan_reconciled', 'watchdog');
    }
    return reconciled;
  }

  /**
   * Same orphan-recovery as reconcileIfOrphaned above, targeting
   * PdfAutoRemediationRun instead of ComparisonTrial -- the production,
   * non-trial path's equivalent. See that method's own doc comment for the
   * full reasoning (liveness via the remediation-cycle lock, the row-lock
   * transaction, and why this is deliberately scoped to only the free/stale
   * case); this is a direct structural mirror, not a new design.
   */
  async reconcileIfOrphanedJobRun(runId: string): Promise<boolean> {
    const run = await prisma.pdfAutoRemediationRun.findUnique({
      where: { id: runId },
      select: { autoStatus: true, jobId: true, autoRoundsCompleted: true },
    });
    if (run?.autoStatus !== 'running') return false;
    const jobId = run.jobId;
    const roundsCompletedBeforeReconcile = run.autoRoundsCompleted;

    const lockStatus = await remediationCycleLockService.getLockStatus(jobId);
    if (lockStatus.inProgress) return false;

    const reconciled = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ remediationCycleLockedAt: Date | null }>>`
        SELECT "remediationCycleLockedAt" FROM "Job" WHERE id = ${jobId} FOR UPDATE
      `;
      const lockedAt = rows[0]?.remediationCycleLockedAt ?? null;
      const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
      const stillOrphaned = lockedAt === null || lockedAt < staleThreshold;
      if (!stillOrphaned) return false;

      const result = await tx.pdfAutoRemediationRun.updateMany({
        where: { id: runId, autoStatus: 'running' },
        data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: new Date() },
      });
      if (result.count > 0) {
        logger.warn(
          `[AutoRemediationLoop] Reconciled orphaned run for job-run ${runId} (job ${jobId}) -- its lock is free/stale, so whatever process was running it must have died without cleaning up (e.g. an ECS deploy mid-round)`
        );
      }
      return result.count > 0;
    });
    if (reconciled) {
      await this.logInterruption(jobId, roundsCompletedBeforeReconcile + 1, 'orphan_reconciled', 'watchdog');
    }
    return reconciled;
  }

  /**
   * Called from the auto-remediation worker's SIGTERM handler, before
   * worker.close() -- see failActiveAutoRemediationBeforeShutdown() in
   * workers/index.ts, the direct structural mirror of
   * failActiveJobsBeforeShutdown() already used for the accessibility queue.
   *
   * Unlike reconcileIfOrphaned/reconcileIfOrphanedJobRun above, this does
   * NOT wait for the remediation-cycle lock to go stale (up to 20 min): a
   * deploy-triggered shutdown is a definite, immediate death of whatever
   * round this worker had active, not a maybe-still-alive case those two
   * exist to distinguish. Real incident, 2026-10-14: a deploy SIGKILLed the
   * worker task mid-round and autoStatus sat at 'running' for ~11 hours
   * because nothing happened to poll the one endpoint that lazily triggers
   * reconciliation -- see reconcileAllOrphanedRuns below for the periodic
   * sweep that closes that gap for crashes (OOM, no graceful SIGTERM at all)
   * this function can't catch.
   *
   * Deliberately does not touch remediationCycleLockService's own lock --
   * left to go stale on its existing 20-minute timer (acquireLock's own OR
   * clause already treats a stale lock as free), same as every other crash
   * path. The only thing this fixes is autoStatus being wrong for however
   * long it takes a client to poll next.
   */
  async forceStopForShutdown(kind: 'trial' | 'jobRun', id: string): Promise<void> {
    try {
      if (kind === 'trial') {
        const result = await prisma.comparisonTrial.updateMany({
          where: { id, autoStatus: 'running' },
          data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: new Date() },
        });
        if (result.count > 0) {
          logger.warn(`[AutoRemediationLoop] Force-stopped trial ${id} for worker shutdown (deploy mid-round)`);
          const trial = await prisma.comparisonTrial.findUnique({
            where: { id },
            select: { ninjaJobId: true, autoRoundsCompleted: true },
          });
          if (trial?.ninjaJobId) {
            await this.logInterruption(trial.ninjaJobId, trial.autoRoundsCompleted + 1, 'force_stopped', 'shutdown');
          }
        }
      } else {
        const result = await prisma.pdfAutoRemediationRun.updateMany({
          where: { id, autoStatus: 'running' },
          data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: new Date() },
        });
        if (result.count > 0) {
          logger.warn(`[AutoRemediationLoop] Force-stopped job-run ${id} for worker shutdown (deploy mid-round)`);
          const run = await prisma.pdfAutoRemediationRun.findUnique({
            where: { id },
            select: { jobId: true, autoRoundsCompleted: true },
          });
          if (run) {
            await this.logInterruption(run.jobId, run.autoRoundsCompleted + 1, 'force_stopped', 'shutdown');
          }
        }
      }
    } catch (err) {
      logger.warn(
        `[AutoRemediationLoop] Failed to force-stop ${kind} ${id} during shutdown (non-fatal -- will self-heal via lock staleness + reconcileIfOrphaned): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Operational Reports Group 4 (reliability) -- see
   * OPERATIONAL_REPORTS_DESIGN.md. Records a deploy/crash-caused
   * interruption into the same append-only RemediationCycleEvent history
   * everything else in this file already writes to, instead of only
   * logger.warn() (CloudWatch-only, not queryable) as before. cycleNumber is
   * a best-effort "the round that was active when this happened" --
   * autoRoundsCompleted + 1, since the actual in-progress cycle number isn't
   * persisted anywhere this function can read it from. logEvent itself is
   * already non-fatal by design (see remediation-cycle-history.service.ts),
   * so no extra try/catch needed here.
   */
  private async logInterruption(
    jobId: string,
    cycleNumber: number,
    action: 'force_stopped' | 'orphan_reconciled',
    source: 'shutdown' | 'watchdog',
  ): Promise<void> {
    await remediationCycleHistoryService.logEvent({
      jobId,
      cycleNumber,
      action,
      source,
      status: 'failed',
      startedAt: new Date(),
    });
  }

  /**
   * Periodic runtime safety net, called from the worker's watchdog interval
   * (same cadence as cleanupStalePdfJobs in workers/index.ts). Sweeps every
   * ComparisonTrial/PdfAutoRemediationRun row currently reporting
   * autoStatus: 'running' through reconcileIfOrphaned/reconcileIfOrphanedJobRun,
   * instead of relying on a client happening to poll the one status/start/
   * stop endpoint that triggers reconciliation today.
   *
   * Real incident, 2026-10-14: a deploy killed an in-flight auto-mode round;
   * nothing polled the right endpoint for ~11 hours, so autoStatus stayed at
   * 'running' the whole time even though the remediation-cycle lock itself
   * had gone stale after 20 minutes. forceStopForShutdown above covers a
   * graceful SIGTERM; this covers everything else (OOM kill, a crash with no
   * signal at all) the same way cleanupStalePdfJobs backstops
   * failActiveJobsBeforeShutdown for the accessibility queue.
   *
   * Each reconcile call is already a no-op for a genuinely still-running
   * trial (its lock is still fresh) or an already-terminal one, so this is
   * safe to run unconditionally on every tick with no extra guarding.
   */
  async reconcileAllOrphanedRuns(): Promise<void> {
    try {
      const [trials, runs] = await Promise.all([
        prisma.comparisonTrial.findMany({
          where: { autoStatus: 'running' },
          select: { id: true, ninjaJobId: true, autoStopRequested: true },
        }),
        prisma.pdfAutoRemediationRun.findMany({
          where: { autoStatus: 'running' },
          select: { id: true, jobId: true, autoStopRequested: true },
        }),
      ]);
      for (const trial of trials) {
        const reconciled = await this.reconcileIfOrphaned(trial.id).catch((err) => {
          logger.warn(`[AutoRemediationLoop] Periodic reconcile failed for trial ${trial.id}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
        if (reconciled && trial.ninjaJobId) {
          await this.maybeAutoResume('trial', trial.id, trial.ninjaJobId, trial.autoStopRequested).catch((err) => {
            logger.warn(`[AutoRemediationLoop] Auto-resume check failed for trial ${trial.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
      for (const run of runs) {
        const reconciled = await this.reconcileIfOrphanedJobRun(run.id).catch((err) => {
          logger.warn(`[AutoRemediationLoop] Periodic reconcile failed for job-run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
        if (reconciled) {
          await this.maybeAutoResume('jobRun', run.id, run.jobId, run.autoStopRequested).catch((err) => {
            logger.warn(`[AutoRemediationLoop] Auto-resume check failed for job-run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    } catch (err) {
      logger.warn(`[AutoRemediationLoop] Periodic orphan-reconcile sweep failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Self-heals a job whose job.output.postRemediationStatus was left at
   * 'pending' forever. Real, confirmed incident (2026-10-29): a job's
   * downloadable remediated PDF was 12.8MB while its own stored
   * auditReport (and the "Role mapping"/alt-text results built from it)
   * still reflected a 9.66MB file, because the process that applied those
   * fixes died between two steps that are NOT atomic: saving the modified
   * PDF to storage (AiAnalysisService.applyApprovedSuggestions sets
   * postRemediationStatus: 'pending' synchronously, right after that
   * save) and the follow-up re-audit that's supposed to flip it to
   * 'complete'/'failed' once it finishes. That follow-up is fire-and-
   * forget in the apply_all HTTP endpoint (pdf-ai-analysis.controller.ts)
   * and merely awaited-within-the-same-process in the auto_loop path
   * (runRound above) -- a full process death (deploy, OOM, crash) in that
   * window leaves the exact same symptom either way, with nothing left
   * running to ever notice or retry it.
   *
   * Reuses the SAME free-or-stale remediation-cycle-lock check
   * reconcileIfOrphaned/reconcileAllOrphanedRuns already use for the
   * identical reason: a lock this job's own cycle still legitimately
   * holds proves its re-audit genuinely hasn't finished yet, so this must
   * never race a cycle that's still in flight. Goes one step further than
   * those two (which only ever flip a status flag) by re-acquiring that
   * SAME lock itself (source 'watchdog') before doing any work -- if a
   * real new cycle grabs it first, this job is simply skipped this tick
   * and that cycle's own completion will resolve it normally.
   */
  async reconcileStalePostRemediation(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
    const candidates = await prisma.job.findMany({
      where: {
        output: { path: ['postRemediationStatus'], equals: 'pending' },
        OR: [
          { remediationCycleLockedAt: null },
          { remediationCycleLockedAt: { lt: staleThreshold } },
        ],
      },
      select: { id: true },
    });

    for (const { id: jobId } of candidates) {
      const lock = await remediationCycleLockService.acquireLock(jobId, 'watchdog', 'watchdog');
      if (!lock.acquired) continue; // a legitimate cycle just grabbed it -- let it finish normally

      const startedAt = new Date();
      try {
        // Re-check under the lock: another cycle may have already
        // resolved this between the findMany above and acquiring the
        // lock just now.
        const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
        const output = (latestJob?.output ?? {}) as Record<string, unknown>;
        if (output.postRemediationStatus !== 'pending') continue;

        const fileName = output.fileName as string | undefined;
        const remediatedFileUrl = output.remediatedFileUrl as string | undefined;
        if (!fileName || !remediatedFileUrl) {
          logger.warn(`[AutoRemediationLoop] Job ${jobId} stuck at postRemediationStatus 'pending' but has no remediated file recorded -- cannot reconcile, leaving as-is`);
          continue;
        }

        const buffer = await fileStorageService.getRemediatedFile(jobId, fileName);
        if (!buffer) {
          logger.warn(`[AutoRemediationLoop] Job ${jobId} stuck at postRemediationStatus 'pending' but its remediated file is missing from storage -- cannot reconcile, leaving as-is`);
          continue;
        }

        logger.warn(`[AutoRemediationLoop] Reconciling orphaned post-remediation re-audit for job ${jobId} -- postRemediationStatus stuck at 'pending' with a free/stale lock (the process that applied these fixes must have died before its own re-audit finished)`);

        const comparison = await pdfReauditService.reauditAndCompare(jobId, buffer, fileName);
        const freshJob = await prisma.job.findUnique({ where: { id: jobId } });
        const freshOutput = (freshJob?.output ?? {}) as Record<string, unknown>;
        const { resolvedCount, remainingCount, regressionCount, resolutionRate } = comparison.metrics;
        await prisma.job.update({
          where: { id: jobId },
          data: {
            output: {
              ...freshOutput,
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
          cycleNumber: lock.cycleNumber!,
          action: 'reaudit',
          source: 'watchdog',
          status: comparison.success ? 'completed' : 'failed',
          resolvedCount,
          remainingCount,
          regressionCount,
          resolutionRate,
          errorMessage: comparison.success ? undefined : comparison.error,
          triggeredBy: 'watchdog',
          startedAt,
        });
        logger.info(`[AutoRemediationLoop] Reconciled stale post-remediation status for job ${jobId}: ${resolvedCount} resolved, ${regressionCount} regressions`);
      } catch (err) {
        logger.warn(`[AutoRemediationLoop] Failed to reconcile stale post-remediation status for job ${jobId} (non-fatal -- will retry next watchdog tick): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await remediationCycleLockService.releaseLock(jobId, lock.cycleNumber!);
      }
    }
  }

  /**
   * Called from reconcileAllOrphanedRuns, only when reconcileIfOrphaned/
   * reconcileIfOrphanedJobRun just found and cleared a GENUINE orphan (the
   * lock-holder died with no signal at all -- OOM, host failure, anything
   * forceStopForShutdown's graceful-SIGTERM path doesn't catch). Turns that
   * into an automatic resume within one watchdog tick of the lock going
   * stale, instead of leaving autoStatus at 'stopped'/'error' until a human
   * (or a client re-polling /auto-mode/start) happens to notice. Real
   * incident, 2026-10-26: exactly this happened to a live production round
   * (worker task died unannounced mid-reaudit) and sat unresumed for 9+
   * hours with nothing to flag it until someone checked by hand.
   *
   * Three guards, all against data that already exists -- no schema change:
   *  - autoStopRequestedBeforeReconcile: honor an explicit user stop over
   *    "resume it anyway." Captured by the caller BEFORE reconcile's own
   *    write unconditionally resets this field to false, so it reflects
   *    what was true going into this crash, not after.
   *  - round/cost ceiling already hit -- the same ceiling startAutoLoop
   *    itself checks every iteration, re-read fresh here since a crashed
   *    round may leave stale counters.
   *  - a crash-recovery cap (MAX_AUTO_CRASH_RESUMES within
   *    CRASH_RECOVERY_LOOKBACK_MS, counted from this job's own
   *    'orphan_reconciled' RemediationCycleEvent rows) -- stops a
   *    deterministically-crashing document (e.g. one that OOMs on every
   *    attempt) from being resumed forever.
   *
   * Dispatches via a direct, un-awaited startAutoLoop call rather than the
   * BullMQ queue enqueueOrRunAutoLoop (pdf-auto-mode.controller.ts) uses for
   * a fresh /start request: reconcileAllOrphanedRuns already runs on the
   * worker process (the stale-job watchdog started in workers/index.ts),
   * which is the exact isolation the queue route exists to provide for a
   * request arriving on the web process -- there's no web-process hop to
   * avoid here, so routing through the queue would add nothing.
   */
  private async maybeAutoResume(
    kind: 'trial' | 'jobRun',
    id: string,
    jobId: string,
    autoStopRequestedBeforeReconcile: boolean
  ): Promise<void> {
    if (autoStopRequestedBeforeReconcile) {
      logger.info(`[AutoRemediationLoop] Not auto-resuming ${kind} ${id} (job ${jobId}) after crash-recovery -- a stop was requested`);
      return;
    }

    const state = kind === 'trial'
      ? await prisma.comparisonTrial.findUnique({
          where: { id },
          select: { autoMaxRounds: true, autoCostLimitUsd: true, autoRoundsCompleted: true, autoCostSpentUsd: true },
        })
      : await prisma.pdfAutoRemediationRun.findUnique({
          where: { id },
          select: { autoMaxRounds: true, autoCostLimitUsd: true, autoRoundsCompleted: true, autoCostSpentUsd: true },
        });
    if (!state) return; // deleted mid-reconcile -- nothing to resume

    if (state.autoRoundsCompleted >= state.autoMaxRounds) {
      logger.info(`[AutoRemediationLoop] Not auto-resuming ${kind} ${id} (job ${jobId}) after crash-recovery -- round limit already reached`);
      return;
    }
    if (state.autoCostSpentUsd >= state.autoCostLimitUsd) {
      logger.info(`[AutoRemediationLoop] Not auto-resuming ${kind} ${id} (job ${jobId}) after crash-recovery -- cost limit already reached`);
      return;
    }

    const history = await remediationCycleHistoryService.listForJob(jobId);
    const cutoff = Date.now() - CRASH_RECOVERY_LOOKBACK_MS;
    const recentCrashCount = history.filter(
      (e) => e.action === 'orphan_reconciled' && e.startedAt.getTime() >= cutoff
    ).length;
    if (recentCrashCount > MAX_AUTO_CRASH_RESUMES) {
      logger.warn(
        `[AutoRemediationLoop] Not auto-resuming ${kind} ${id} (job ${jobId}) -- ${recentCrashCount} crash-recoveries in the last ${CRASH_RECOVERY_LOOKBACK_MS / 60000}min, over the ${MAX_AUTO_CRASH_RESUMES} cap. Leaving for manual review.`
      );
      return;
    }

    logger.info(
      `[AutoRemediationLoop] Auto-resuming ${kind} ${id} (job ${jobId}) after crash-recovery (${recentCrashCount} of ${MAX_AUTO_CRASH_RESUMES} cap used)`
    );
    const driver = kind === 'trial' ? new ComparisonTrialAutoRemediationDriver(id) : new JobAutoRemediationDriver(id);
    this.startAutoLoop(driver).catch((err) => {
      logger.error(
        `[AutoRemediationLoop] Unexpected error auto-resuming ${kind} ${id} (job ${jobId}) after crash-recovery: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  /**
   * Starts (or resumes) an auto-mode run for whatever `driver` targets.
   * Intended to be called fire-and-forget from the /auto-mode/start endpoint
   * for a ComparisonTrialAutoRemediationDriver (today's only caller); all
   * progress and the terminal result are persisted via the driver, which
   * /auto-mode/status reads back for the Comparison Study case. A batch
   * orchestrator using a JobAutoRemediationDriver awaits this instead, since
   * it needs to know when the run finishes to release its concurrency lease.
   */
  async startAutoLoop(driver: AutoRemediationDriver): Promise<void> {
    const config = await driver.getConfig();
    if (!config) {
      logger.warn(`[AutoRemediationLoop] ${driver.describe()}: not found, missing job, or not in auto mode -- refusing to start`);
      return;
    }
    const { jobId, tenantId } = config;

    let lock;
    try {
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
        `[AutoRemediationLoop] Failed to start auto loop for ${driver.describe()} (job ${jobId}): ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    const cycleNumber = lock.cycleNumber!;
    const heartbeat = remediationCycleLockService.startHeartbeat(jobId, cycleNumber);
    const loopStartedAt = new Date();

    // Fresh run -- reset the counters even if a previous run left them
    // populated, so a restarted auto-mode session reports its own totals.
    await driver.resetForNewRun(loopStartedAt);

    let stopReason: AutoStopReason = 'converged';
    let roundsCompleted = 0;
    let costSpentUsd = 0;
    let consecutiveStalls = 0;
    let stopErrorMessage: string | undefined;

    try {
      while (true) {
        const state = await driver.getRoundState();
        if (!state) {
          // Real incident (2026-10-17, PdfBatch): fired with zero rounds
          // completed, moments after driver.getConfig() found this same
          // record -- root cause still unconfirmed (a genuine delete? a
          // Neon serverless connection-pooling read-after-write gap?).
          // This branch previously logged nothing at all, making it
          // indistinguishable from total log silence -- the exact signature
          // every other PDF-batch "hang" investigated this session turned
          // out NOT to be. Always log it now so a recurrence is diagnosable
          // without re-deriving this from code reading.
          logger.error(
            `[AutoRemediationLoop] ${driver.describe()}: getRoundState() returned null after getConfig() succeeded -- stopping with zero rounds`
          );
          stopReason = 'error';
          break;
        }
        // All three checks happen before starting a round, never mid-round --
        // a round is always allowed to finish once started, so a stop
        // request/ceiling never leaves the PDF half-applied.
        if (state.autoStopRequested) {
          stopReason = 'manual_stop';
          break;
        }
        if (roundsCompleted >= state.autoMaxRounds) {
          stopReason = 'round_limit';
          break;
        }
        if (costSpentUsd >= state.autoCostLimitUsd) {
          stopReason = 'budget_limit';
          break;
        }

        const { actionableFound, resolvedCount } = await this.runRound(
          jobId,
          cycleNumber,
          tenantId,
          resolveColorContrastMode(state.autoColorContrastMode),
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
          | { gemini?: { estimatedCostUsd?: number }; claude?: { estimatedCostUsd?: number } }
          | undefined;
        // Real bug, found while building the processing-log/cost-reporting
        // feature: this only ever summed Gemini spend, silently dropping
        // real Claude Haiku cost from suggestion types routed there in the
        // same round (ai-analysis.service.ts computes both).
        costSpentUsd += (stats?.gemini?.estimatedCostUsd ?? 0) + (stats?.claude?.estimatedCostUsd ?? 0);

        await driver.recordRoundProgress(roundsCompleted, costSpentUsd);

        // Keyed on resolvedCount (re-audit-confirmed net progress), not the
        // raw applied count -- a round can apply a handful of genuinely new,
        // unrelated suggestions (keeping `applied` non-zero) while the
        // re-audit still shows zero real progress, e.g. because most of what
        // got "applied" was actually re-approved, permanently-failing
        // suggestions from an earlier round net cancelling out against a
        // small amount of real work. Real incident (Math_Olszewski_PDF.pdf,
        // 2026-10-20): rounds 2 and 3 each applied 2 (non-zero), so this
        // check never fired under the old `applied === 0` condition, even
        // though the re-audit showed resolvedCount: 0, remainingCount: 948
        // unchanged both times -- stop distinctly rather than let the
        // round/cost ceiling silently absorb the real cause (see
        // STALL_ROUND_LIMIT's doc comment above).
        if (resolvedCount <= 0) {
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
      stopErrorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        `[AutoRemediationLoop] Job ${jobId} (${driver.describe()}) stopped on error after ${roundsCompleted} round(s): ${stopErrorMessage}`
      );
    } finally {
      remediationCycleLockService.stopHeartbeat(heartbeat);
      // Terminal state is written BEFORE the lock is released (not after) --
      // otherwise there's a window where the lock reads as free while
      // autoStatus still says 'running', during which a status/stop request
      // could wrongly think this run was orphaned (reconcileIfOrphaned
      // above, Comparison Study only), or a brand new run could start and
      // then have ITS OWN 'running' status clobbered by this write landing
      // late (CodeRabbit/Codex finding). Writing first closes both: by the
      // time the lock is actually free, this run's true terminal state is
      // already committed.
      //
      // The write is wrapped in its own try/finally so a failure here (a
      // transient DB error, or the underlying record being deleted
      // concurrently) still releases the lock -- otherwise, with the
      // heartbeat already stopped, the job would stay locked for the full
      // 20-minute staleness window with nothing left to renew it. If the
      // write does fail, the driver's own state is left at 'running' with a
      // now-free lock -- exactly the state reconcileIfOrphaned exists to
      // detect and correct later (Comparison Study only, for now).
      try {
        await driver.markStopped(stopReason, new Date());
      } finally {
        await remediationCycleLockService.releaseLock(jobId, cycleNumber);
      }
      // RemediationCycleEvent has no dedicated rounds/cost columns -- the
      // authoritative numbers live wherever the driver persists them (read
      // by GET /auto-mode/status for Comparison Study). This is just a
      // marker entry in the same append-only history the manual flow uses,
      // summarized into errorMessage regardless of outcome since that's the
      // only free-text field available on the event.
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
        `[AutoRemediationLoop] Job ${jobId} (${driver.describe()}) finished: ${roundsCompleted} round(s), $${costSpentUsd.toFixed(4)} spent, stopped: ${stopReason}`
      );

      // Operator notification -- the whole point of autonomous rounds is
      // that nobody has to watch them; this is the "come back, a decision
      // is needed" signal. 'manual_stop' is deliberately excluded: the
      // operator just stopped it themselves, so telling them it stopped
      // would be pure noise. Fire-and-forget, same convention
      // workflow.queue.ts's own notification calls already use -- never
      // worth blocking or failing this method over a notification-write
      // hiccup, after the lock is already released and the real history
      // event already logged above.
      if (stopReason !== 'manual_stop') {
        // Narrowed into its own const: `stopReason` is a mutable outer `let`,
        // so TS can't carry the `!== 'manual_stop'` narrowing through into
        // the .then() closure below on its own.
        const notifiableStopReason = stopReason;
        prisma.job.findUnique({ where: { id: jobId }, select: { userId: true, input: true } })
          .then((jobRow) => {
            if (!jobRow) return;
            const fileName = (jobRow.input as Record<string, unknown> | null)?.fileName as string | undefined;
            const label = fileName ? `"${fileName}"` : 'Your document';
            const { type, title, message } = describeAutoLoopStop(notifiableStopReason, label, roundsCompleted, costSpentUsd, stopErrorMessage);
            return notificationService.createNotification({
              userId: jobRow.userId,
              tenantId,
              type,
              title,
              message,
              link: `/pdf/audit/${jobId}`,
            });
          })
          .catch((notifyErr) => {
            logger.error(`[AutoRemediationLoop] Failed to create stop notification for job ${jobId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
          });
      }
    }
  }

  /**
   * This round's AI spend, read off job.output.aiAnalysisStats right after
   * analyzeJob writes it fresh for the round (overwritten each round, never
   * accumulated -- see the real Gemini-only-summed cost bug this exact shape
   * caused elsewhere in this file, line ~570). Non-fatal: a missing/odd
   * output shouldn't block logging the round's other history fields.
   */
  private async getRoundAiCostUsd(jobId: string): Promise<number> {
    try {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true } });
      const stats = (job?.output as Record<string, unknown> | undefined)?.aiAnalysisStats as
        | { gemini?: { estimatedCostUsd?: number }; claude?: { estimatedCostUsd?: number } }
        | undefined;
      return (stats?.gemini?.estimatedCostUsd ?? 0) + (stats?.claude?.estimatedCostUsd ?? 0);
    } catch (err) {
      logger.warn(`[AutoRemediationLoop] Failed to read round AI cost for job ${jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
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
  ): Promise<{ actionableFound: number; applied: number; resolvedCount: number }> {
    const roundStartedAt = new Date();
    const analysis = await aiAnalysisService.analyzeJob(
      jobId,
      tenantId,
      colorContrastModeOverride !== undefined ? { colorContrastMode: colorContrastModeOverride } : undefined,
    );
    // This round's AI spend (Operational Reports Group 2 -- see
    // OPERATIONAL_REPORTS_DESIGN.md's costUsd field). analyzeJob just wrote
    // job.output.aiAnalysisStats fresh for THIS round (overwritten, not
    // accumulated -- same read pattern the outer loop below already uses to
    // build its own cumulative costSpentUsd, duplicated here deliberately
    // rather than threaded through a shared helper, so the outer loop's
    // existing, already-correct accumulation logic stays untouched).
    const roundCostUsd = await this.getRoundAiCostUsd(jobId);
    await remediationCycleHistoryService.logEvent({
      jobId,
      cycleNumber,
      action: 'ai_analysis',
      source: 'auto_loop',
      status: 'completed',
      costUsd: roundCostUsd,
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
      return { actionableFound: 0, applied: 0, resolvedCount: 0 };
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
    // Captured now, before the reaudit call below, and used at every return
    // point in this function from here on -- `result.applied` is the only
    // field this function still needs after this point, but reading it from
    // `result` itself (rather than this local) at the final `return` would
    // keep the whole `result` object, including its potentially
    // hundreds-of-MB `modifiedBuffer`, referenced for the entire reaudit
    // call and everything after it. Real finding from the 2026-10-26 FMHE
    // OOM investigation: that buffer has no reason to outlive this point.
    const appliedCount = result.applied;
    if (appliedCount === 0 || !result.modifiedBuffer || !result.fileName) {
      return { actionableFound, applied: appliedCount, resolvedCount: 0 };
    }
    const { modifiedBuffer, fileName } = result;

    const reauditStartedAt = new Date();
    const comparison = await pdfReauditService.reauditAndCompare(jobId, modifiedBuffer, fileName);
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

    return { actionableFound, applied: appliedCount, resolvedCount };
  }
}

export const autoRemediationLoopService = new AutoRemediationLoopService();
