/**
 * Remediation Cycle Lock Service Tests
 *
 * Focus areas:
 * - acquireLock reflects the atomic updateMany's count (1 = acquired, 0 = rejected)
 * - a rejected acquire reports the current holder's lockedAt/lockedBy/source
 * - getLockStatus treats a lock older than the staleness threshold as not-in-progress
 * - releaseLock/touchLock never throw even if the underlying update fails
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { remediationCycleLockService } from '../../../../src/services/pdf/remediation-cycle-lock.service';

const mockPrisma = prisma as unknown as {
  job: {
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
};

describe('remediation-cycle-lock.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('acquireLock', () => {
    it('acquires and returns the freshly-incremented cycleNumber when updateMany affects one row', async () => {
      mockPrisma.job.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.job.findUnique.mockResolvedValue({
        remediationCycleCounter: 3,
        remediationCycleLockedAt: new Date(),
        remediationCycleLockedBy: 'user-1',
        remediationCycleSource: 'apply_all',
      });

      const result = await remediationCycleLockService.acquireLock('job-1', 'user-1', 'apply_all');

      expect(mockPrisma.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'job-1',
            OR: expect.arrayContaining([
              { remediationCycleLockedAt: null },
              expect.objectContaining({ remediationCycleLockedAt: expect.objectContaining({ lt: expect.any(Date) }) }),
            ]),
          }),
          data: expect.objectContaining({
            remediationCycleLockedBy: 'user-1',
            remediationCycleSource: 'apply_all',
            remediationCycleCounter: { increment: 1 },
          }),
        })
      );
      expect(result).toEqual({
        acquired: true,
        cycleNumber: 3,
        lockedAt: expect.any(Date),
        lockedBy: 'user-1',
        source: 'apply_all',
      });
    });

    it('rejects and reports the current holder when updateMany affects zero rows', async () => {
      mockPrisma.job.updateMany.mockResolvedValue({ count: 0 });
      const lockedAt = new Date();
      mockPrisma.job.findUnique.mockResolvedValue({
        remediationCycleLockedAt: lockedAt,
        remediationCycleLockedBy: 'other-user',
        remediationCycleSource: 'analyze_job',
      });

      const result = await remediationCycleLockService.acquireLock('job-1', 'user-1', 'apply_all');

      expect(result.acquired).toBe(false);
      expect(result.lockedBy).toBe('other-user');
      expect(result.source).toBe('analyze_job');
      expect(result.lockedAt).toBe(lockedAt);
    });
  });

  describe('getLockStatus', () => {
    it('reports inProgress: true for a fresh lock', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({
        remediationCycleLockedAt: new Date(),
        remediationCycleLockedBy: 'user-1',
        remediationCycleSource: 'apply_all',
      });

      const status = await remediationCycleLockService.getLockStatus('job-1');

      expect(status.inProgress).toBe(true);
    });

    it('reports inProgress: false once the lock is older than the staleness threshold', async () => {
      const veryOld = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      mockPrisma.job.findUnique.mockResolvedValue({
        remediationCycleLockedAt: veryOld,
        remediationCycleLockedBy: 'crashed-worker',
        remediationCycleSource: 'reaudit_pdf_upload',
      });

      const status = await remediationCycleLockService.getLockStatus('job-1');

      expect(status.inProgress).toBe(false);
    });

    it('reports inProgress: false when no lock is held', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({
        remediationCycleLockedAt: null,
        remediationCycleLockedBy: null,
        remediationCycleSource: null,
      });

      const status = await remediationCycleLockService.getLockStatus('job-1');

      expect(status.inProgress).toBe(false);
    });
  });

  describe('releaseLock / touchLock', () => {
    it('releaseLock clears the lock columns', async () => {
      mockPrisma.job.update.mockResolvedValue({});

      await remediationCycleLockService.releaseLock('job-1');

      expect(mockPrisma.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: {
          remediationCycleLockedAt: null,
          remediationCycleLockedBy: null,
          remediationCycleSource: null,
        },
      });
    });

    it('releaseLock does not throw when the update fails (self-heals via staleness timeout)', async () => {
      mockPrisma.job.update.mockRejectedValue(new Error('db down'));

      await expect(remediationCycleLockService.releaseLock('job-1')).resolves.toBeUndefined();
    });

    it('touchLock does not throw when the update fails', async () => {
      mockPrisma.job.update.mockRejectedValue(new Error('db down'));

      await expect(remediationCycleLockService.touchLock('job-1')).resolves.toBeUndefined();
    });
  });
});
