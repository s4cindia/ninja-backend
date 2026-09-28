/**
 * PDF Batch Concurrency Budget Service
 *
 * Covers the weighted-tier pure functions, the atomic admission
 * compare-and-swap (tryAcquireLease), the polling wrapper (waitForLease,
 * including abort-signal cancellation), lease release (including
 * double-release/unknown-lease safety and the atomic budget/lease
 * transaction), and the stale-lease watchdog (reconcileStaleLeases,
 * including its atomic re-check of a lease's heartbeat at release time).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// $transaction invokes its callback against a `tx` that shares the SAME
// pdfConcurrencyBudget/pdfConcurrencyLease mock functions as the top-level
// client (matching the established pattern in
// tests/unit/services/pdf/auto-remediation-loop.service.test.ts), so a test
// can assert via prisma.pdfConcurrencyBudget.updateMany /
// prisma.pdfConcurrencyLease.create regardless of whether the real code
// called them through `tx` or directly.
vi.mock('../../../../src/lib/prisma', () => {
  const pdfConcurrencyBudget = {
    upsert: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  };
  const pdfConcurrencyLease = {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  };
  return {
    default: {
      pdfConcurrencyBudget,
      pdfConcurrencyLease,
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ pdfConcurrencyBudget, pdfConcurrencyLease }),
    },
  };
});

import prisma from '../../../../src/lib/prisma';
import {
  concurrencyBudgetService,
  computeSizeWeight,
  computePageWeight,
  computeEffectiveWeight,
} from '../../../../src/services/pdf-batch/concurrency-budget.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeSizeWeight', () => {
  const MB = 1024 * 1024;
  it('is "small" (1) just under the small tier boundary (50MB)', () => {
    expect(computeSizeWeight(49 * MB)).toBe(1);
  });
  it('is "medium" (3) at exactly the small tier boundary', () => {
    expect(computeSizeWeight(50 * MB)).toBe(3);
  });
  it('is "medium" (3) just under the medium tier boundary (500MB)', () => {
    expect(computeSizeWeight(499 * MB)).toBe(3);
  });
  it('is "large" (8) at exactly the medium tier boundary', () => {
    expect(computeSizeWeight(500 * MB)).toBe(8);
  });
  it('accepts a BigInt (PdfBatchItem.fileSize is BigInt, not Int)', () => {
    expect(computeSizeWeight(BigInt(10 * MB))).toBe(1);
  });
});

describe('computePageWeight', () => {
  it('is "small" (1) just under the small tier boundary (50 pages)', () => {
    expect(computePageWeight(49)).toBe(1);
  });
  it('is "medium" (3) at exactly the small tier boundary', () => {
    expect(computePageWeight(50)).toBe(3);
  });
  it('is "large" (8) at exactly the medium tier boundary (300 pages)', () => {
    expect(computePageWeight(300)).toBe(8);
  });
});

describe('computeEffectiveWeight', () => {
  it('takes whichever dimension is more conservative (higher)', () => {
    expect(computeEffectiveWeight(1, 8)).toBe(8);
    expect(computeEffectiveWeight(8, 1)).toBe(8);
    expect(computeEffectiveWeight(3, 3)).toBe(3);
  });
});

describe('tryAcquireLease', () => {
  it('admits when unitsInUse + weightUnits fits under the tenant budget, and creates a lease', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 5 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-1' } as any);

    const result = await concurrencyBudgetService.tryAcquireLease('tenant-1', 'item-1', 'audit', 3);

    // Lazily creates the tenant's budget row on first use.
    expect(prisma.pdfConcurrencyBudget.upsert).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      create: { tenantId: 'tenant-1', totalUnits: 10 },
      update: {},
    });
    // The atomic compare-and-swap: admits only if CURRENT unitsInUse (evaluated
    // live by Postgres at UPDATE time, not the value read above) is <=
    // totalUnits - weightUnits. Runs inside the same $transaction as the
    // lease create, so the two can never diverge on a crash mid-way.
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', unitsInUse: { lte: 7 } }, // 10 - 3
      data: { unitsInUse: { increment: 3 } },
    });
    expect(prisma.pdfConcurrencyLease.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', batchItemId: 'item-1', phase: 'audit', weightUnits: 3 },
    });
    expect(result).toEqual({ acquired: true, leaseId: 'lease-1' });
  });

  it('refuses admission (no lease created) when the compare-and-swap matches 0 rows', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 9 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 0 } as any);

    const result = await concurrencyBudgetService.tryAcquireLease('tenant-1', 'item-1', 'audit', 8);

    expect(result).toEqual({ acquired: false });
    expect(prisma.pdfConcurrencyLease.create).not.toHaveBeenCalled();
  });

  it('a large file alone (weight 8) is admitted under a fresh 10-unit budget, matching the "1 large alone" example', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 0 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-large' } as any);

    const result = await concurrencyBudgetService.tryAcquireLease('tenant-1', 'item-large', 'audit', 8);

    expect(result.acquired).toBe(true);
  });

  it('isolates budgets per tenant -- the admission check is scoped to tenantId', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-2', totalUnits: 10, unitsInUse: 0 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-2' } as any);

    await concurrencyBudgetService.tryAcquireLease('tenant-2', 'item-1', 'audit', 8);

    expect(prisma.pdfConcurrencyBudget.findUniqueOrThrow).toHaveBeenCalledWith({ where: { tenantId: 'tenant-2' } });
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-2', unitsInUse: { lte: 2 } },
      data: { unitsInUse: { increment: 8 } },
    });
  });

  it('throws (fails fast) rather than admitting when weightUnits alone exceeds the tenant total -- this can never fit, not just currently unavailable', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 0 } as any);

    await expect(concurrencyBudgetService.tryAcquireLease('tenant-1', 'item-1', 'audit', 12)).rejects.toThrow(/exceeds the tenant's total budget/);
    expect(prisma.pdfConcurrencyBudget.updateMany).not.toHaveBeenCalled();
  });

  it('admits when weightUnits exactly equals the tenant total (the item takes the whole budget)', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 0 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-1' } as any);

    const result = await concurrencyBudgetService.tryAcquireLease('tenant-1', 'item-1', 'audit', 10);

    expect(result.acquired).toBe(true);
  });
});

describe('waitForLease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when the first attempt is admitted', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 0 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-1' } as any);

    const leaseId = await concurrencyBudgetService.waitForLease('tenant-1', 'item-1', 'audit', 1);

    expect(leaseId).toBe('lease-1');
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledTimes(1);
  });

  it('polls (with the configured base interval) until budget frees up, holding the caller until then', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 10 } as any);
    // First two admission attempts fail, third succeeds.
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany)
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyLease.create).mockResolvedValue({ id: 'lease-eventual' } as any);

    const promise = concurrencyBudgetService.waitForLease('tenant-1', 'item-1', 'audit', 3, 5000);
    // Base interval is 5000ms; jitter adds up to 30% (1500ms) on top -- 7000ms
    // comfortably clears two full poll cycles regardless of jitter.
    await vi.advanceTimersByTimeAsync(7000);
    await vi.advanceTimersByTimeAsync(7000);

    const leaseId = await promise;
    expect(leaseId).toBe('lease-eventual');
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledTimes(3);
  });

  it('aborts immediately (before ever trying to acquire) when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      concurrencyBudgetService.waitForLease('tenant-1', 'item-1', 'audit', 3, 5000, controller.signal)
    ).rejects.toThrow(/aborted/);
    expect(prisma.pdfConcurrencyBudget.upsert).not.toHaveBeenCalled();
  });

  it('cancels an in-progress poll wait the moment the signal aborts, rather than finishing out the interval', async () => {
    vi.mocked(prisma.pdfConcurrencyBudget.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.pdfConcurrencyBudget.findUniqueOrThrow).mockResolvedValue({ tenantId: 'tenant-1', totalUnits: 10, unitsInUse: 10 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 0 } as any);
    const controller = new AbortController();

    const promise = concurrencyBudgetService.waitForLease('tenant-1', 'item-1', 'audit', 3, 5000, controller.signal);
    const assertion = expect(promise).rejects.toThrow(/aborted/);
    // First attempt fails, loop enters the poll wait -- abort partway through
    // the interval instead of letting it run to completion.
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await assertion;

    // Never reached a second admission attempt -- the abort cut the wait
    // short instead of a ghost retry sneaking through after the caller gave up.
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('releaseLease', () => {
  it('marks the lease released and decrements the tenant budget by its weight, in one transaction', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findUnique).mockResolvedValue({ id: 'lease-1', tenantId: 'tenant-1', weightUnits: 3, releasedAt: null } as any);
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);

    const released = await concurrencyBudgetService.releaseLease('lease-1');

    expect(released).toBe(true);
    expect(prisma.pdfConcurrencyLease.updateMany).toHaveBeenCalledWith({
      where: { id: 'lease-1', releasedAt: null },
      data: { releasedAt: expect.any(Date) },
    });
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      data: { unitsInUse: { decrement: 3 } },
    });
  });

  it('is a no-op for an unknown lease id (logs, does not touch the budget)', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findUnique).mockResolvedValue(null as any);

    const released = await concurrencyBudgetService.releaseLease('does-not-exist');

    expect(released).toBe(false);
    expect(prisma.pdfConcurrencyBudget.updateMany).not.toHaveBeenCalled();
  });

  it('does not double-decrement when the lease was already released by a concurrent caller', async () => {
    // Real race this closes: a watchdog reconciliation and the lease
    // holder's own cleanup both call releaseLease for the same lease.
    vi.mocked(prisma.pdfConcurrencyLease.findUnique).mockResolvedValue({ id: 'lease-1', tenantId: 'tenant-1', weightUnits: 3, releasedAt: new Date() } as any);
    // The compare-and-swap (releasedAt: null) matches 0 rows since it was
    // already released.
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 0 } as any);

    const released = await concurrencyBudgetService.releaseLease('lease-1');

    expect(released).toBe(false);
    expect(prisma.pdfConcurrencyBudget.updateMany).not.toHaveBeenCalled();
  });

  it('folds requireStaleBefore into the same atomic compare-and-swap, for the watchdog\'s use', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findUnique).mockResolvedValue({ id: 'lease-1', tenantId: 'tenant-1', weightUnits: 3, releasedAt: null } as any);
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);
    const staleThreshold = new Date('2026-01-01T00:00:00Z');

    await concurrencyBudgetService.releaseLease('lease-1', { requireStaleBefore: staleThreshold });

    expect(prisma.pdfConcurrencyLease.updateMany).toHaveBeenCalledWith({
      where: { id: 'lease-1', releasedAt: null, heartbeatAt: { lt: staleThreshold } },
      data: { releasedAt: expect.any(Date) },
    });
  });
});

describe('heartbeatLease', () => {
  it('re-stamps heartbeatAt for a still-held lease', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 1 } as any);

    await concurrencyBudgetService.heartbeatLease('lease-1');

    expect(prisma.pdfConcurrencyLease.updateMany).toHaveBeenCalledWith({
      where: { id: 'lease-1', releasedAt: null },
      data: { heartbeatAt: expect.any(Date) },
    });
  });

  it('swallows a failure rather than throwing (non-fatal, matching remediationCycleLockService.touchLock)', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockRejectedValue(new Error('DB blip'));

    await expect(concurrencyBudgetService.heartbeatLease('lease-1')).resolves.toBeUndefined();
  });
});

describe('reconcileStaleLeases', () => {
  it('releases every lease whose heartbeat is older than the staleness threshold', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findMany).mockResolvedValue([
      { id: 'stale-1', tenantId: 'tenant-1', batchItemId: 'item-1', phase: 'audit', weightUnits: 3, releasedAt: null },
      { id: 'stale-2', tenantId: 'tenant-2', batchItemId: 'item-2', phase: 'auto_remediation', weightUnits: 8, releasedAt: null },
    ] as any);
    vi.mocked(prisma.pdfConcurrencyLease.findUnique)
      .mockResolvedValueOnce({ id: 'stale-1', tenantId: 'tenant-1', weightUnits: 3, releasedAt: null } as any)
      .mockResolvedValueOnce({ id: 'stale-2', tenantId: 'tenant-2', weightUnits: 8, releasedAt: null } as any);
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.pdfConcurrencyBudget.updateMany).mockResolvedValue({ count: 1 } as any);

    const reconciledCount = await concurrencyBudgetService.reconcileStaleLeases();

    expect(reconciledCount).toBe(2);
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      data: { unitsInUse: { decrement: 3 } },
    });
    expect(prisma.pdfConcurrencyBudget.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-2' },
      data: { unitsInUse: { decrement: 8 } },
    });
    // Each release's compare-and-swap re-requires the SAME captured
    // staleThreshold from findMany, atomically, rather than trusting the
    // findMany snapshot alone.
    expect(prisma.pdfConcurrencyLease.updateMany).toHaveBeenCalledWith({
      where: { id: 'stale-1', releasedAt: null, heartbeatAt: { lt: expect.any(Date) } },
      data: { releasedAt: expect.any(Date) },
    });
  });

  it('does not count (or decrement the budget for) a lease whose heartbeat refreshed between findMany and the atomic release recheck', async () => {
    // Real race this closes: a lease heartbeats (still genuinely active)
    // right after findMany selected it as stale, but before releaseLease
    // runs its own atomic recheck.
    vi.mocked(prisma.pdfConcurrencyLease.findMany).mockResolvedValue([
      { id: 'stale-1', tenantId: 'tenant-1', batchItemId: 'item-1', phase: 'audit', weightUnits: 3, releasedAt: null },
    ] as any);
    vi.mocked(prisma.pdfConcurrencyLease.findUnique).mockResolvedValue({ id: 'stale-1', tenantId: 'tenant-1', weightUnits: 3, releasedAt: null } as any);
    // heartbeatAt no longer < staleThreshold -> the CAS matches 0 rows.
    vi.mocked(prisma.pdfConcurrencyLease.updateMany).mockResolvedValue({ count: 0 } as any);

    const reconciledCount = await concurrencyBudgetService.reconcileStaleLeases();

    expect(reconciledCount).toBe(0);
    expect(prisma.pdfConcurrencyBudget.updateMany).not.toHaveBeenCalled();
  });

  it('only queries leases that are unreleased and past the staleness threshold', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findMany).mockResolvedValue([]);

    await concurrencyBudgetService.reconcileStaleLeases();

    expect(prisma.pdfConcurrencyLease.findMany).toHaveBeenCalledWith({
      where: { releasedAt: null, heartbeatAt: { lt: expect.any(Date) } },
    });
  });

  it('returns 0 and touches nothing when no leases are stale', async () => {
    vi.mocked(prisma.pdfConcurrencyLease.findMany).mockResolvedValue([]);

    const reconciledCount = await concurrencyBudgetService.reconcileStaleLeases();

    expect(reconciledCount).toBe(0);
    expect(prisma.pdfConcurrencyBudget.updateMany).not.toHaveBeenCalled();
  });
});
