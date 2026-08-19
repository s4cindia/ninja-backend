/**
 * Remediation Session Service Tests
 *
 * Focus areas:
 * - startSession / endSession write the same fields AnnotationSession's
 *   equivalents do, just with the remediation event vocabulary
 * - endSession syncs ComparisonTrial.ninjaActiveMs by summing all of the
 *   job's sessions, but only when the job actually belongs to a trial
 * - a failed sync never breaks endSession for ordinary (non-trial) jobs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    remediationSession: {
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
    },
    comparisonTrial: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { remediationSessionService } from '../../../../src/services/pdf/remediation-session.service';

const mockPrisma = prisma as unknown as {
  remediationSession: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  comparisonTrial: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe('remediation-session.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('startSession', () => {
    it('creates a session scoped to the job and operator', async () => {
      mockPrisma.remediationSession.create.mockResolvedValue({ id: 'sess-1' });

      const sessionId = await remediationSessionService.startSession('job-1', 'op-1');

      expect(mockPrisma.remediationSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ jobId: 'job-1', operatorId: 'op-1' }),
      });
      expect(sessionId).toBe('sess-1');
    });
  });

  describe('endSession', () => {
    const endInput = {
      activeMs: 5000,
      idleMs: 1000,
      issuesApplied: 3,
      suggestionsAccepted: 2,
      suggestionsRejected: 1,
      bulkApplyUsed: true,
    };

    it('writes the session summary and is a no-op on trial sync when the job is not a trial', async () => {
      mockPrisma.remediationSession.update.mockResolvedValue({ id: 'sess-1', jobId: 'job-1' });
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue(null);

      await remediationSessionService.endSession('sess-1', endInput);

      expect(mockPrisma.remediationSession.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: expect.objectContaining({
          activeMs: 5000,
          idleMs: 1000,
          issuesApplied: 3,
          suggestionsAccepted: 2,
          suggestionsRejected: 1,
          bulkApplyUsed: true,
        }),
      });
      expect(mockPrisma.comparisonTrial.findUnique).toHaveBeenCalledWith({
        where: { ninjaJobId: 'job-1' },
        select: { id: true },
      });
      expect(mockPrisma.comparisonTrial.update).not.toHaveBeenCalled();
    });

    it('sums all of the job\'s sessions onto the trial when the job belongs to one', async () => {
      mockPrisma.remediationSession.update.mockResolvedValue({ id: 'sess-1', jobId: 'job-1' });
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1' });
      mockPrisma.remediationSession.aggregate.mockResolvedValue({ _sum: { activeMs: 12000 } });

      await remediationSessionService.endSession('sess-1', endInput);

      expect(mockPrisma.remediationSession.aggregate).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        _sum: { activeMs: true },
      });
      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { ninjaActiveMs: 12000 },
      });
    });

    it('does not throw when the trial sync fails', async () => {
      mockPrisma.remediationSession.update.mockResolvedValue({ id: 'sess-1', jobId: 'job-1' });
      mockPrisma.comparisonTrial.findUnique.mockRejectedValue(new Error('db down'));

      await expect(remediationSessionService.endSession('sess-1', endInput)).resolves.toBeUndefined();
    });
  });
});
