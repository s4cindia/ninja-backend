/**
 * PDF Batch Concurrency Budget Service
 *
 * A weighted, per-tenant concurrency budget for PDF batch processing --
 * gates how many batch items can be actively auditing/auto-remediating at
 * once, weighted by file size/page count rather than a flat file count
 * (the "5 small files, or 1 large alone" scenario from the approved
 * batch-processing plan). Backed by PdfConcurrencyBudget/PdfConcurrencyLease
 * (Postgres), not an in-process counter -- this backend's deployment
 * topology (single instance vs multiple ECS tasks) can't be confirmed from
 * this repo, and an in-memory semaphore would be silently wrong the moment
 * this runs on more than one task.
 *
 * Admission is a single atomic `updateMany` compare-and-swap, the same
 * pattern remediation-cycle-lock.service.ts already established for this
 * class of problem: the WHERE clause's `unitsInUse: { lte: ... }` condition
 * is evaluated by Postgres against the row's live, currently-committed
 * value at the moment each UPDATE statement actually executes (serialized
 * via the row's own lock during that statement) -- not against a value
 * fetched earlier in application code. Two concurrent admission attempts
 * therefore can never both succeed past the ceiling: whichever commits
 * first raises unitsInUse, and the second's WHERE clause is re-evaluated
 * against that new value. The one non-atomic read (this.getTotalUnits,
 * used to compute the ceiling threshold) only matters for a rare,
 * out-of-band admin change to the ceiling itself -- not for concurrent
 * lease acquisition, which is what this mechanism exists to serialize.
 *
 * The budget-counter update and its paired lease row write (create on
 * acquire, in reverse on release) run inside a single `prisma.$transaction`
 * -- otherwise a crash between the two steps would leave `unitsInUse`
 * permanently out of sync with reality: elevated with no lease for the
 * watchdog to find (acquire), or a released lease whose weight was never
 * returned (release). Neither can self-heal without this (CodeRabbit
 * finding on PR #635).
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { pdfBatchConfig } from '../../config/pdf-batch.config';

export type ConcurrencyLeasePhase = 'audit' | 'auto_remediation';

export interface AcquireLeaseResult {
  acquired: boolean;
  leaseId?: string;
}

/** Weight tier from file size alone -- immediately available at upload time,
 *  before any processing. */
export function computeSizeWeight(fileSizeBytes: bigint | number): number {
  const mb = Number(fileSizeBytes) / (1024 * 1024);
  if (mb < pdfBatchConfig.sizeTiers.smallMaxMb) return pdfBatchConfig.weightUnits.small;
  if (mb < pdfBatchConfig.sizeTiers.mediumMaxMb) return pdfBatchConfig.weightUnits.medium;
  return pdfBatchConfig.weightUnits.large;
}

/** Weight tier from real page count, once the audit determines it -- a
 *  small-byte-size PDF can still be page-heavy (mostly text, or vector-
 *  heavy scans), and per-page validators scale with page count independent
 *  of file size. */
export function computePageWeight(pageCount: number): number {
  if (pageCount < pdfBatchConfig.pageTiers.smallMaxPages) return pdfBatchConfig.weightUnits.small;
  if (pageCount < pdfBatchConfig.pageTiers.mediumMaxPages) return pdfBatchConfig.weightUnits.medium;
  return pdfBatchConfig.weightUnits.large;
}

/** The value actually used for admission from a given point on --
 *  whichever dimension (size or page count) is more conservative. */
export function computeEffectiveWeight(sizeWeightUnits: number, pageWeightUnits: number): number {
  return Math.max(sizeWeightUnits, pageWeightUnits);
}

/** Rejects a request for more weight than a tenant's budget could EVER grant
 *  (a misconfigured tier weight above the ceiling, e.g. an env override
 *  raising PDF_BATCH_WEIGHT_LARGE past PDF_BATCH_BUDGET_TOTAL_UNITS) --
 *  admission's `lte` check would otherwise never match even at 0 usage,
 *  hanging waitForLease's poll loop forever (CodeRabbit finding on PR #635). */
class WeightExceedsBudgetError extends Error {
  constructor(tenantId: string, weightUnits: number, totalUnits: number) {
    super(
      `[ConcurrencyBudget] Cannot admit for tenant ${tenantId}: weight ${weightUnits} exceeds the tenant's total budget of ${totalUnits} units -- this request can never fit under the current ceiling`
    );
    this.name = 'WeightExceedsBudgetError';
  }
}

class ConcurrencyBudgetService {
  /** Lazily creates a tenant's budget row on first use. Safe under
   *  concurrent first-ever calls for the same tenant -- Prisma's upsert
   *  compiles to an atomic INSERT ... ON CONFLICT DO UPDATE for Postgres. */
  private async ensureBudgetRow(tenantId: string): Promise<void> {
    await prisma.pdfConcurrencyBudget.upsert({
      where: { tenantId },
      create: { tenantId, totalUnits: pdfBatchConfig.defaultBudgetUnits },
      update: {},
    });
  }

  /**
   * Attempts to admit `weightUnits` of load for `batchItemId` under
   * `tenantId`'s budget. Non-blocking -- returns immediately either way;
   * see waitForLease for a polling wrapper. On success, creates a
   * PdfConcurrencyLease row the caller must eventually release (and should
   * heartbeat while genuinely still using it -- see heartbeatLease).
   *
   * Throws WeightExceedsBudgetError if weightUnits alone could never fit
   * under the tenant's total budget -- a misconfiguration, not a transient
   * capacity shortage, so it fails fast instead of polling forever.
   */
  async tryAcquireLease(
    tenantId: string,
    batchItemId: string,
    phase: ConcurrencyLeasePhase,
    weightUnits: number,
  ): Promise<AcquireLeaseResult> {
    await this.ensureBudgetRow(tenantId);
    const budget = await prisma.pdfConcurrencyBudget.findUniqueOrThrow({ where: { tenantId } });
    if (weightUnits > budget.totalUnits) {
      throw new WeightExceedsBudgetError(tenantId, weightUnits, budget.totalUnits);
    }
    const maxUnitsInUseToAdmit = budget.totalUnits - weightUnits;

    const leaseId = await prisma.$transaction(async (tx) => {
      const result = await tx.pdfConcurrencyBudget.updateMany({
        where: { tenantId, unitsInUse: { lte: maxUnitsInUseToAdmit } },
        data: { unitsInUse: { increment: weightUnits } },
      });
      if (result.count === 0) return null;

      const lease = await tx.pdfConcurrencyLease.create({
        data: { tenantId, batchItemId, phase, weightUnits },
      });
      return lease.id;
    });

    if (leaseId === null) return { acquired: false };
    return { acquired: true, leaseId };
  }

  /**
   * Polls tryAcquireLease (with jitter, to avoid a thundering herd of
   * queued items all retrying in lockstep) until budget is available, or
   * until `signal` is aborted. Passing a signal lets a caller race this
   * against its own timeout WITHOUT leaving an orphaned poll loop running
   * behind it -- an un-cancelled loop could keep polling after the caller
   * gave up, later acquire a lease nobody holds a reference to anymore, and
   * consume tenant budget until stale reconciliation frees it (CodeRabbit
   * finding on PR #635). Without a signal, waits indefinitely.
   */
  async waitForLease(
    tenantId: string,
    batchItemId: string,
    phase: ConcurrencyLeasePhase,
    weightUnits: number,
    pollMs: number = pdfBatchConfig.admitPollMs,
    signal?: AbortSignal,
  ): Promise<string> {
    for (;;) {
      if (signal?.aborted) {
        throw new Error(`[ConcurrencyBudget] waitForLease aborted for batch item ${batchItemId} before a lease was acquired`);
      }
      const result = await this.tryAcquireLease(tenantId, batchItemId, phase, weightUnits);
      if (result.acquired) return result.leaseId!;
      const jitterMs = Math.random() * pollMs * 0.3;
      await this.delayOrAbort(pollMs + jitterMs, signal);
    }
  }

  /** setTimeout that resolves early (by rejecting) the moment `signal`
   *  aborts, instead of letting the current poll interval run out first. */
  private delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('[ConcurrencyBudget] waitForLease aborted while waiting between poll attempts'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Releases a held lease and returns its weight to the tenant's budget.
   * Idempotent -- a lease already released (releasedAt not null) is a
   * silent no-op, so a watchdog reconciliation racing against the lease
   * holder's own cleanup can never double-decrement unitsInUse. Safe to
   * call with an unknown/already-deleted leaseId (logs and returns).
   *
   * `requireStaleBefore`, used only by reconcileStaleLeases, folds the
   * watchdog's staleness check into the SAME atomic compare-and-swap as the
   * releasedAt check -- so a lease whose heartbeat legitimately refreshes
   * between the watchdog's query and this call is re-validated against a
   * live, currently-committed value and correctly left alone, rather than
   * being released out from under whatever process still holds it
   * (CodeRabbit finding on PR #635).
   *
   * Returns whether THIS call actually performed the release (false for an
   * unknown lease, an already-released lease, or -- when
   * requireStaleBefore is set -- a lease no longer stale).
   */
  async releaseLease(leaseId: string, options?: { requireStaleBefore?: Date }): Promise<boolean> {
    const lease = await prisma.pdfConcurrencyLease.findUnique({ where: { id: leaseId } });
    if (!lease) {
      logger.warn(`[ConcurrencyBudget] releaseLease called for unknown lease ${leaseId} -- ignoring`);
      return false;
    }

    return prisma.$transaction(async (tx) => {
      const result = await tx.pdfConcurrencyLease.updateMany({
        where: {
          id: leaseId,
          releasedAt: null,
          ...(options?.requireStaleBefore ? { heartbeatAt: { lt: options.requireStaleBefore } } : {}),
        },
        data: { releasedAt: new Date() },
      });
      if (result.count === 0) return false; // already released, or no longer stale

      await tx.pdfConcurrencyBudget.updateMany({
        where: { tenantId: lease.tenantId },
        data: { unitsInUse: { decrement: lease.weightUnits } },
      });
      return true;
    });
  }

  /** Re-stamps heartbeatAt for a lease still genuinely in use -- keeps a
   *  long-running audit/auto-remediation phase from crossing the staleness
   *  threshold and being reclaimed by the watchdog while still legitimately
   *  active. Non-fatal on failure, matching remediationCycleLockService.touchLock's
   *  own tolerance: a missed tick only makes this lease eligible for
   *  staleness-based reconciliation slightly early. */
  async heartbeatLease(leaseId: string): Promise<void> {
    await prisma.pdfConcurrencyLease
      .updateMany({
        where: { id: leaseId, releasedAt: null },
        data: { heartbeatAt: new Date() },
      })
      .catch((err) => {
        logger.warn(`[ConcurrencyBudget] Failed to renew lease heartbeat ${leaseId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /**
   * Watchdog: releases any lease whose heartbeat has gone stale (the
   * process holding it died without releasing it -- e.g. an ECS deploy
   * mid-round, mirroring reconcileIfOrphaned's own crash-recovery rationale
   * in auto-remediation-loop.service.ts). Safe to call repeatedly/on a
   * schedule -- a genuinely still-active lease's own heartbeat keeps it out
   * of the stale window entirely. Returns the number ACTUALLY reconciled
   * (excludes any lease that re-validated as no-longer-stale inside
   * releaseLease's atomic recheck).
   */
  async reconcileStaleLeases(): Promise<number> {
    const staleThreshold = new Date(Date.now() - pdfBatchConfig.leaseStaleMs);
    const staleLeases = await prisma.pdfConcurrencyLease.findMany({
      where: { releasedAt: null, heartbeatAt: { lt: staleThreshold } },
    });

    let reconciledCount = 0;
    for (const lease of staleLeases) {
      logger.warn(
        `[ConcurrencyBudget] Reconciling stale lease ${lease.id} (tenant ${lease.tenantId}, batch item ${lease.batchItemId}, phase ${lease.phase}) -- heartbeat stopped, whatever process held it must have died`
      );
      const released = await this.releaseLease(lease.id, { requireStaleBefore: staleThreshold });
      if (released) reconciledCount++;
    }

    return reconciledCount;
  }
}

export const concurrencyBudgetService = new ConcurrencyBudgetService();
