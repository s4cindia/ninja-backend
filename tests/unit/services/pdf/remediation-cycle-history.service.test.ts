/**
 * Remediation Cycle History Service Tests
 *
 * Focus areas:
 * - logEvent persists the given fields plus a fresh completedAt
 * - logEvent swallows a create() failure rather than throwing (a logging
 *   failure must never fail the parent request that already did the real work)
 * - listForJob returns events ordered ascending by startedAt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    remediationCycleEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { remediationCycleHistoryService } from '../../../../src/services/pdf/remediation-cycle-history.service';

const mockPrisma = prisma as unknown as {
  remediationCycleEvent: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

describe('remediation-cycle-history.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('logEvent', () => {
    const baseInput = {
      jobId: 'job-1',
      cycleNumber: 2,
      action: 'apply_fixes' as const,
      source: 'apply_all' as const,
      status: 'completed' as const,
      appliedCount: 5,
      failedCount: 1,
      triggeredBy: 'user-1',
      startedAt: new Date('2026-08-30T00:00:00.000Z'),
    };

    it('creates a row with the given fields plus a fresh completedAt', async () => {
      mockPrisma.remediationCycleEvent.create.mockResolvedValue({ id: 'evt-1' });

      await remediationCycleHistoryService.logEvent(baseInput);

      expect(mockPrisma.remediationCycleEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          jobId: 'job-1',
          cycleNumber: 2,
          action: 'apply_fixes',
          source: 'apply_all',
          status: 'completed',
          appliedCount: 5,
          failedCount: 1,
          completedAt: expect.any(Date),
        }),
      });
    });

    it('does not throw when create() rejects', async () => {
      mockPrisma.remediationCycleEvent.create.mockRejectedValue(new Error('db down'));

      await expect(remediationCycleHistoryService.logEvent(baseInput)).resolves.toBeUndefined();
    });
  });

  describe('listForJob', () => {
    it('queries by jobId ordered ascending by startedAt', async () => {
      const events = [{ id: 'evt-1' }, { id: 'evt-2' }];
      mockPrisma.remediationCycleEvent.findMany.mockResolvedValue(events);

      const result = await remediationCycleHistoryService.listForJob('job-1');

      expect(mockPrisma.remediationCycleEvent.findMany).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        orderBy: { startedAt: 'asc' },
      });
      expect(result).toBe(events);
    });
  });
});
