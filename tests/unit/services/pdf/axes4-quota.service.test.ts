/**
 * axes4 PAC Cloud page-quota tracker -- covers the atomic admission
 * compare-and-swap (tryReservePages), the period-rollover reset, and
 * getStatus. Modeled directly on this session's own
 * concurrency-budget.service.test.ts (PdfConcurrencyBudget), the closest
 * precedent for this exact atomic-CAS-on-Postgres pattern.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    axes4PageQuota: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/config/axes4.config', () => ({
  axes4Config: {
    apiKey: '',
    subscriptionId: '',
    apiUrl: 'https://api.axes4.com/pac',
    timeoutMs: 300_000,
    checksets: ['pdfua'],
    quota: {
      defaultPagesPerPeriod: 500,
      periodDays: 30,
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { axes4QuotaService } from '../../../../src/services/pdf/axes4-quota.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tryReservePages', () => {
  it('admits when pagesUsedThisPeriod + pageCount fits under the period limit', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 100,
      pagesLimitThisPeriod: 500,
      periodResetAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
    vi.mocked(prisma.axes4PageQuota.updateMany).mockResolvedValue({ count: 1 } as any);

    const reserved = await axes4QuotaService.tryReservePages(50);

    expect(prisma.axes4PageQuota.upsert).toHaveBeenCalledWith({
      where: { scopeKey: 'global' },
      create: { scopeKey: 'global', pagesLimitThisPeriod: 500, periodResetAt: expect.any(Date) },
      update: { pagesLimitThisPeriod: 500 },
    });
    // The atomic compare-and-swap: admits only if CURRENT pagesUsedThisPeriod
    // (evaluated live by Postgres at UPDATE time) is <= limit - pageCount.
    expect(prisma.axes4PageQuota.updateMany).toHaveBeenCalledWith({
      where: { scopeKey: 'global', pagesUsedThisPeriod: { lte: 450 } }, // 500 - 50
      data: { pagesUsedThisPeriod: { increment: 50 } },
    });
    expect(reserved).toBe(true);
  });

  it('reconciles an existing row\'s limit to the current config on every call, not just at creation', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 100,
      pagesLimitThisPeriod: 500,
      periodResetAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
    vi.mocked(prisma.axes4PageQuota.updateMany).mockResolvedValue({ count: 1 } as any);

    await axes4QuotaService.tryReservePages(10);

    // update is never {} -- a changed config limit must reach an existing
    // row, not just a newly-created one. pagesUsedThisPeriod/periodResetAt
    // are deliberately absent from `update` here: reconciling the limit
    // must never reset accumulated usage or the period clock.
    expect(prisma.axes4PageQuota.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { pagesLimitThisPeriod: 500 } })
    );
  });

  it('refuses (returns false, no throw) when the compare-and-swap matches 0 rows', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 480,
      pagesLimitThisPeriod: 500,
      periodResetAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
    vi.mocked(prisma.axes4PageQuota.updateMany).mockResolvedValue({ count: 0 } as any);

    const reserved = await axes4QuotaService.tryReservePages(50);

    expect(reserved).toBe(false);
  });

  it('refuses a single request whose own pageCount exceeds the whole period limit, without throwing', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 0,
      pagesLimitThisPeriod: 500,
      periodResetAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
    // lte: 500 - 600 = -100 -- pagesUsedThisPeriod (>= 0) can never satisfy
    // this, so the real DB would correctly match 0 rows.
    vi.mocked(prisma.axes4PageQuota.updateMany).mockResolvedValue({ count: 0 } as any);

    await expect(axes4QuotaService.tryReservePages(600)).resolves.toBe(false);
  });

  it('short-circuits to true for a zero-or-negative pageCount without touching the database', async () => {
    const reserved = await axes4QuotaService.tryReservePages(0);

    expect(reserved).toBe(true);
    expect(prisma.axes4PageQuota.upsert).not.toHaveBeenCalled();
  });

  it('atomically rolls the period over when periodResetAt has passed, before checking admission', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.updateMany)
      .mockResolvedValueOnce({ count: 1 } as any) // the reset call
      .mockResolvedValueOnce({ count: 1 } as any); // the reservation call
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 0, // already rolled over by the time this is read
      pagesLimitThisPeriod: 500,
      periodResetAt: expect.any(Date),
    } as any);

    await axes4QuotaService.tryReservePages(10);

    // First updateMany call is the period-rollover reset, gated on
    // periodResetAt already having passed -- the same atomic-CAS reasoning
    // as the reservation itself (two concurrent callers racing this can't
    // both reset, since the second's WHERE re-evaluates against the
    // already-rolled-over row).
    expect(prisma.axes4PageQuota.updateMany).toHaveBeenNthCalledWith(1, {
      where: { scopeKey: 'global', periodResetAt: { lte: expect.any(Date) } },
      data: { pagesUsedThisPeriod: 0, periodResetAt: expect.any(Date) },
    });
  });
});

describe('getStatus', () => {
  it('returns the current usage snapshot after ensuring the row exists and resetting if elapsed', async () => {
    vi.mocked(prisma.axes4PageQuota.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.axes4PageQuota.updateMany).mockResolvedValue({ count: 0 } as any);
    const periodResetAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    vi.mocked(prisma.axes4PageQuota.findUniqueOrThrow).mockResolvedValue({
      scopeKey: 'global',
      pagesUsedThisPeriod: 42,
      pagesLimitThisPeriod: 500,
      periodResetAt,
    } as any);

    const status = await axes4QuotaService.getStatus();

    expect(status).toEqual({ pagesUsedThisPeriod: 42, pagesLimitThisPeriod: 500, periodResetAt });
  });
});
