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
import { remediationCycleHistoryService, computeRemediationCounts } from '../../../../src/services/pdf/remediation-cycle-history.service';

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

  /**
   * Shared by pdf-batch-orchestrator.service.ts's one-time PdfBatchItem
   * write and pdf-batch.controller.ts's live GET /pdf-batches/:batchId
   * read -- a single source of truth so the two can never drift apart the
   * way the original issuesAutoFixed bug (PR #708) did.
   */
  describe('computeRemediationCounts', () => {
    it('derives the cumulative total from the gap between the original issue count and the LATEST reaudit, not the last round\'s own resolvedCount (PR #708 regression: Math_Olszewski_PDF.pdf, 344/0/0 resolved across 3 rounds)', async () => {
      mockPrisma.remediationCycleEvent.findMany.mockResolvedValue([
        { action: 'reaudit', status: 'completed', resolvedCount: 344, remainingCount: 947, regressionCount: 1 },
        { action: 'reaudit', status: 'completed', resolvedCount: 0, remainingCount: 948, regressionCount: 0 },
        { action: 'reaudit', status: 'completed', resolvedCount: 0, remainingCount: 948, regressionCount: 0 },
      ]);

      const result = await computeRemediationCounts('job-1', 1291);

      expect(result).toEqual({ issuesAutoFixed: 343, issuesGuidanceOnly: 948 });
    });

    it('returns null when no reaudit has ever completed for this job', async () => {
      mockPrisma.remediationCycleEvent.findMany.mockResolvedValue([
        { action: 'ai_analysis', status: 'completed', resolvedCount: null, remainingCount: null },
      ]);

      const result = await computeRemediationCounts('job-1', 1291);

      expect(result).toBeNull();
    });

    it('reflects a LATER reaudit appended after an earlier terminal snapshot -- the job-level-resume scenario', async () => {
      // Simulates: the batch orchestrator's one-time write happened after
      // the first 3 events (budget_limit stop), then POST
      // /pdf/:jobId/auto-mode/start resumed the loop and a 4th round's
      // reaudit was appended later, real further progress accrued.
      mockPrisma.remediationCycleEvent.findMany.mockResolvedValue([
        { action: 'reaudit', status: 'completed', resolvedCount: 344, remainingCount: 947, regressionCount: 1 },
        { action: 'reaudit', status: 'completed', resolvedCount: 0, remainingCount: 948, regressionCount: 0 },
        { action: 'reaudit', status: 'completed', resolvedCount: 0, remainingCount: 948, regressionCount: 0 },
        { action: 'reaudit', status: 'completed', resolvedCount: 212, remainingCount: 212, regressionCount: 0 },
      ]);

      const result = await computeRemediationCounts('job-1', 1291);

      expect(result).toEqual({ issuesAutoFixed: 1079, issuesGuidanceOnly: 212 });
    });
  });
});
