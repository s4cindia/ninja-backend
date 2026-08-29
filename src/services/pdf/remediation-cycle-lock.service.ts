/**
 * Remediation Cycle Lock Service
 *
 * Guards against two overlapping "apply fixes -> re-audit -> re-run AI
 * analysis" cycles running concurrently on the same job. Before this lock
 * existed, every write site in that cycle did an independent
 * read-modify-write of job.output with no coordination -- a client-side
 * retry (e.g. after a false-timeout "Network Error" on a slow-but-successful
 * call) could start a second cycle while the first was still finishing, and
 * whichever write landed last silently won regardless of which cycle
 * represented more real progress.
 *
 * acquireLock is a genuine fix, not a narrowed race window: it uses a single
 * atomic `updateMany` compare-and-swap rather than a separate check-then-
 * write. Postgres takes the row lock as part of executing the UPDATE itself,
 * so if two calls race, the second one's WHERE clause is re-evaluated
 * against the row as the first call already committed it -- which by then
 * has a fresh, non-null remediationCycleLockedAt -- so it matches 0 rows.
 * There is no gap between "check" and "write": they are the same statement.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export type RemediationCycleSource =
  | 'apply_all'
  | 'apply_single'
  | 'reaudit_pdf_upload'
  | 'reaudit_current_file'
  | 'analyze_job';

/** Lock ttl for automatic staleness-based recovery from a crashed worker.
 * Paired with a heartbeat (see startHeartbeat) so a legitimately long-running
 * cycle never crosses this threshold while still genuinely in progress --
 * this value only ever matters for a lock that was truly abandoned. */
const STALE_LOCK_MS = 20 * 60 * 1000;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface AcquireLockResult {
  acquired: boolean;
  cycleNumber?: number;
  lockedAt?: Date;
  lockedBy?: string;
  source?: string;
}

export interface LockStatus {
  inProgress: boolean;
  lockedAt?: Date;
  lockedBy?: string;
  source?: string;
}

class RemediationCycleLockService {
  async acquireLock(
    jobId: string,
    lockedBy: string,
    source: RemediationCycleSource
  ): Promise<AcquireLockResult> {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - STALE_LOCK_MS);

    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        OR: [
          { remediationCycleLockedAt: null },
          { remediationCycleLockedAt: { lt: staleThreshold } },
        ],
      },
      data: {
        remediationCycleLockedAt: now,
        remediationCycleLockedBy: lockedBy,
        remediationCycleSource: source,
        remediationCycleCounter: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.getLockStatus(jobId);
      return {
        acquired: false,
        lockedAt: current.lockedAt,
        lockedBy: current.lockedBy,
        source: current.source,
      };
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        remediationCycleCounter: true,
        remediationCycleLockedAt: true,
        remediationCycleLockedBy: true,
        remediationCycleSource: true,
      },
    });

    return {
      acquired: true,
      cycleNumber: job?.remediationCycleCounter,
      lockedAt: job?.remediationCycleLockedAt ?? undefined,
      lockedBy: job?.remediationCycleLockedBy ?? undefined,
      source: job?.remediationCycleSource ?? undefined,
    };
  }

  /**
   * Releases the lock only if `cycleNumber` still matches the row's current
   * remediationCycleCounter -- i.e. only if the caller is still the actual
   * owner. Without this check, a cycle whose lock was reclaimed via
   * staleness recovery (its heartbeat missed enough ticks, or it was truly
   * abandoned) could finish late and unconditionally clear a NEWER cycle's
   * lock out from under it, letting a third cycle start while the second is
   * still running -- exactly the overwrite behavior this service exists to
   * prevent. cycleNumber is the token returned by acquireLock; every caller
   * must pass the value it was given at acquisition time.
   *
   * Non-fatal: a failed/no-op release is bounded by the staleness timeout,
   * which is this mechanism's own designed safety net for exactly this case.
   */
  async releaseLock(jobId: string, cycleNumber: number): Promise<void> {
    await prisma.job
      .updateMany({
        where: { id: jobId, remediationCycleCounter: cycleNumber },
        data: {
          remediationCycleLockedAt: null,
          remediationCycleLockedBy: null,
          remediationCycleSource: null,
        },
      })
      .catch((err) => {
        logger.warn(
          `[RemediationCycleLock] Failed to release lock for job ${jobId} (non-fatal -- will self-heal via staleness timeout): ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /** Re-stamps lockedAt to "now" for a lock this process still legitimately
   * holds. Keeps a long-running cycle (large-PDF re-audit, big-batch AI
   * analysis) from crossing the staleness threshold and being reclaimed by
   * another request while still genuinely in progress. Conditioned on
   * `cycleNumber` for the same ownership reason as releaseLock -- a stale
   * cycle's own heartbeat must not keep re-stamping a newer cycle's lock
   * after that lock has already been reclaimed, or the newer cycle's
   * staleness accounting would be silently driven by the old one. Non-fatal:
   * a missed tick only makes this cycle eligible for staleness-based
   * takeover slightly early, a far smaller risk than the race this exists
   * to close.
   */
  async touchLock(jobId: string, cycleNumber: number): Promise<void> {
    await prisma.job
      .updateMany({
        where: { id: jobId, remediationCycleCounter: cycleNumber },
        data: { remediationCycleLockedAt: new Date() },
      })
      .catch((err) => {
        logger.warn(
          `[RemediationCycleLock] Failed to renew lock heartbeat for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  startHeartbeat(
    jobId: string,
    cycleNumber: number,
    intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS
  ): NodeJS.Timeout {
    return setInterval(() => {
      void this.touchLock(jobId, cycleNumber);
    }, intervalMs);
  }

  stopHeartbeat(handle: NodeJS.Timeout): void {
    clearInterval(handle);
  }

  async getLockStatus(jobId: string): Promise<LockStatus> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        remediationCycleLockedAt: true,
        remediationCycleLockedBy: true,
        remediationCycleSource: true,
      },
    });

    const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
    // A stale lock reads as not-in-progress even though the column is still
    // non-null -- otherwise a crashed cycle would show as "still running"
    // forever on the frontend even though the next acquireLock would succeed.
    const inProgress = !!job?.remediationCycleLockedAt && job.remediationCycleLockedAt >= staleThreshold;

    return {
      inProgress,
      lockedAt: job?.remediationCycleLockedAt ?? undefined,
      lockedBy: job?.remediationCycleLockedBy ?? undefined,
      source: job?.remediationCycleSource ?? undefined,
    };
  }
}

export const remediationCycleLockService = new RemediationCycleLockService();
