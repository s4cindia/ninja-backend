/**
 * axes4 PAC Cloud page-quota tracker
 *
 * axes4 bills per page checked (the exact unit is unconfirmed -- see the
 * axes4 integration plan's own open questions -- but the deprecated v2
 * `apiKeyUsageResult` schema's totalPages/usedPages fields strongly imply
 * it). This tracks cumulative pages consumed against a rolling period
 * budget, so axes4-pac.service.ts can refuse a call locally BEFORE making a
 * doomed round-trip, rather than only finding out via the API's own 403
 * ("You have reached the page limit for your api-key") after the fact.
 *
 * The 403 response is still the authoritative backstop regardless of this
 * tracker -- local state can drift (e.g. a page consumed by a DIFFERENT
 * caller of the same axes4 subscription, outside Ninja entirely, that this
 * tracker has no way to observe). This exists purely to avoid *wasted*
 * calls in the common case, not to be a perfectly accurate ledger.
 *
 * Modeled directly on this session's own concurrency-budget.service.ts
 * (PdfConcurrencyBudget) -- same atomic `updateMany` compare-and-swap
 * admission pattern (Postgres re-evaluates the WHERE clause against the
 * row's live, currently-committed value at UPDATE time, not a value read
 * earlier in application code, so two concurrent reservations can never
 * both push pagesUsedThisPeriod past the ceiling). Deliberately simpler
 * than that service in one respect: pages consumed here are never "released"
 * back -- there's no lease/heartbeat/stale-reconciliation lifecycle, just a
 * period-based reset.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { axes4Config } from '../../config/axes4.config';

// Single shared row for now -- see prisma/schema.prisma's own Axes4PageQuota
// doc comment for why this is a string key rather than a tenantId column.
const GLOBAL_SCOPE_KEY = 'global';

class Axes4QuotaService {
  /** Lazily creates the quota row on first use, and reconciles an existing
   *  row's limit to the current config on every call -- not just at
   *  creation. Without this, a config change (e.g. a trial's page limit
   *  being raised, or a plan change) would silently never reach an
   *  already-existing row: upsert's own `update` only runs when the row
   *  is found, and a bare `update: {}` would leave pagesLimitThisPeriod
   *  frozen at whatever it was first created with, forever (CodeRabbit/
   *  Codex both caught this independently on PR #639). pagesUsedThisPeriod
   *  and periodResetAt are deliberately left untouched here -- reconciling
   *  the limit must never reset accumulated usage or the period clock.
   *  Safe under concurrent first-ever calls -- Prisma's upsert compiles to
   *  an atomic INSERT ... ON CONFLICT DO UPDATE for Postgres. */
  private async ensureRow(): Promise<void> {
    await prisma.axes4PageQuota.upsert({
      where: { scopeKey: GLOBAL_SCOPE_KEY },
      create: {
        scopeKey: GLOBAL_SCOPE_KEY,
        pagesLimitThisPeriod: axes4Config.quota.defaultPagesPerPeriod,
        periodResetAt: this.nextPeriodResetAt(),
      },
      update: {
        pagesLimitThisPeriod: axes4Config.quota.defaultPagesPerPeriod,
      },
    });
  }

  private nextPeriodResetAt(): Date {
    return new Date(Date.now() + axes4Config.quota.periodDays * 24 * 60 * 60 * 1000);
  }

  /** Atomically rolls the quota over to a fresh period once periodResetAt
   *  has passed. The WHERE clause's own periodResetAt check means two
   *  concurrent calls racing this can't both reset -- only whichever
   *  commits first matches the condition; the second's WHERE re-evaluates
   *  against the now-already-rolled-over row and matches nothing. */
  private async resetIfPeriodElapsed(): Promise<void> {
    const now = new Date();
    await prisma.axes4PageQuota.updateMany({
      where: { scopeKey: GLOBAL_SCOPE_KEY, periodResetAt: { lte: now } },
      data: { pagesUsedThisPeriod: 0, periodResetAt: this.nextPeriodResetAt() },
    });
  }

  /**
   * Attempts to reserve `pageCount` pages against the current period's
   * budget. Non-blocking -- there is no "wait" variant (unlike
   * concurrency-budget.service.ts's waitForLease): quota does not free up
   * again until the next period rolls over, so polling would never help
   * within a single request's lifetime.
   *
   * Returns false (never throws) both when the reservation would exceed the
   * remaining budget AND when pageCount alone exceeds the period's total
   * limit -- the latter isn't a distinct "misconfiguration" error case the
   * way concurrency-budget.service.ts's WeightExceedsBudgetError is, since
   * there's no polling loop here that could hang forever on it; the caller
   * (axes4-pac.service.ts) just treats a false the same as quota being
   * temporarily exhausted, and skips the API call either way.
   */
  async tryReservePages(pageCount: number): Promise<boolean> {
    if (pageCount <= 0) return true;

    await this.ensureRow();
    await this.resetIfPeriodElapsed();

    const quota = await prisma.axes4PageQuota.findUniqueOrThrow({ where: { scopeKey: GLOBAL_SCOPE_KEY } });
    const maxUsedToAdmit = quota.pagesLimitThisPeriod - pageCount;

    const result = await prisma.axes4PageQuota.updateMany({
      where: { scopeKey: GLOBAL_SCOPE_KEY, pagesUsedThisPeriod: { lte: maxUsedToAdmit } },
      data: { pagesUsedThisPeriod: { increment: pageCount } },
    });

    if (result.count === 0) {
      logger.warn(
        `[Axes4Quota] Refusing to reserve ${pageCount} page(s) -- would exceed the current period's budget (limit ${quota.pagesLimitThisPeriod})`
      );
      return false;
    }
    return true;
  }

  /** Current usage snapshot, for status/monitoring purposes -- not used in
   *  the admission path itself (tryReservePages re-reads fresh every time). */
  async getStatus(): Promise<{ pagesUsedThisPeriod: number; pagesLimitThisPeriod: number; periodResetAt: Date }> {
    await this.ensureRow();
    await this.resetIfPeriodElapsed();
    const quota = await prisma.axes4PageQuota.findUniqueOrThrow({ where: { scopeKey: GLOBAL_SCOPE_KEY } });
    return {
      pagesUsedThisPeriod: quota.pagesUsedThisPeriod,
      pagesLimitThisPeriod: quota.pagesLimitThisPeriod,
      periodResetAt: quota.periodResetAt,
    };
  }
}

export const axes4QuotaService = new Axes4QuotaService();
