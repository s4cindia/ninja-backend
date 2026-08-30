/**
 * Auto Remediation Loop Service
 *
 * Covers the loop's stop conditions (converged / round_limit / budget_limit /
 * manual_stop / error), the decorative-suggestion carve-out, and that the
 * remediation-cycle lock is always released regardless of how the loop ends.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: { findUnique: vi.fn(), update: vi.fn() },
    job: { findUnique: vi.fn(), update: vi.fn() },
    aiAnalysis: { updateMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock('../../../../src/services/pdf/ai-analysis.service');
vi.mock('../../../../src/services/pdf/pdf-reaudit.service');
vi.mock('../../../../src/services/pdf/remediation-cycle-lock.service');
vi.mock('../../../../src/services/pdf/remediation-cycle-history.service');
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { autoRemediationLoopService } from '../../../../src/services/pdf/auto-remediation-loop.service';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { pdfReauditService } from '../../../../src/services/pdf/pdf-reaudit.service';
import { remediationCycleLockService } from '../../../../src/services/pdf/remediation-cycle-lock.service';

function makeTrial(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trial-1',
    ninjaJobId: 'job-1',
    mode: 'auto',
    autoMaxRounds: 10,
    autoCostLimitUsd: 2.0,
    autoStopRequested: false,
    ...overrides,
  };
}

function mockLockAcquired(cycleNumber = 7) {
  vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({
    acquired: true,
    cycleNumber,
  } as any);
  vi.mocked(remediationCycleLockService.startHeartbeat).mockReturnValue('heartbeat' as any);
}

function mockSuccessfulRound(costUsd = 0) {
  vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
  vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(aiAnalysisService.applyApprovedSuggestions).mockResolvedValue({
    applied: 1,
    failed: 0,
    errors: [],
    modifiedBuffer: Buffer.from('pdf'),
    fileName: 'doc.pdf',
  });
  vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
    success: true,
    jobId: 'job-1',
    originalAuditId: 'job-1',
    reauditId: 'job-1-reaudit',
    fileName: 'doc.pdf',
    comparison: { resolved: [], remaining: [], regressions: [] },
    metrics: { totalOriginal: 0, totalNew: 0, resolvedCount: 1, remainingCount: 0, regressionCount: 0, resolutionRate: 100 },
    reauditReport: { issues: [] } as any,
  } as any);
  vi.mocked(prisma.job.findUnique).mockResolvedValue({
    id: 'job-1',
    tenantId: 'tenant-1',
    output: { aiAnalysisStats: { gemini: { estimatedCostUsd: costUsd } } },
  } as any);
}

describe('autoRemediationLoopService.startAutoLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing if the trial is not in auto mode', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ mode: 'manual' }) as any);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(remediationCycleLockService.acquireLock).not.toHaveBeenCalled();
  });

  it('does nothing if the remediation lock cannot be acquired', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' } as any);
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: false } as any);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.update).not.toHaveBeenCalled();
  });

  it('stops as converged once no actionable non-decorative apply-to-pdf suggestions remain, and releases the lock', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique)
      .mockResolvedValueOnce(makeTrial() as any) // initial lookup
      .mockResolvedValue(makeTrial() as any); // per-round re-fetch
    mockLockAcquired(7);
    mockSuccessfulRound(0.01);
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(0);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 7);
    expect(remediationCycleLockService.stopHeartbeat).toHaveBeenCalledWith('heartbeat');
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false },
    });
  });

  it('excludes alt-text-decorative from both the auto-approve update and the convergence count', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired();
    mockSuccessfulRound(0);
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(0);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(prisma.aiAnalysis.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ suggestionType: { not: 'alt-text-decorative' }, status: 'pending' }),
        data: { status: 'approved', approvedBy: 'auto-mode' },
      })
    );
    expect(prisma.aiAnalysis.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          suggestionType: { not: 'alt-text-decorative' },
          status: { in: ['pending', 'approved'] },
        }),
      })
    );
  });

  it('stops at the round ceiling when suggestions never run out', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoMaxRounds: 2 }) as any);
    mockLockAcquired();
    mockSuccessfulRound(0);
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(5); // always more work

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'round_limit', autoStopRequested: false },
    });
  });

  it('stops at the budget ceiling once cumulative Gemini cost meets or exceeds the limit', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoCostLimitUsd: 1.0 }) as any);
    mockLockAcquired();
    mockSuccessfulRound(1.5); // exceeds the $1.00 ceiling after round 1
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(5);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'budget_limit', autoStopRequested: false },
    });
  });

  it('honors a manual stop request between rounds, never mid-round', async () => {
    // findUnique is called once for the initial trial lookup, then once at
    // the top of each loop iteration. Call #1 = initial lookup, #2 = round
    // 1's pre-check (must allow it through), #3 = round 2's pre-check
    // (requests the stop, only after round 1 has already fully completed).
    let call = 0;
    vi.mocked(prisma.comparisonTrial.findUnique).mockImplementation(() => {
      call++;
      return Promise.resolve(makeTrial({ autoStopRequested: call > 2 }) as any);
    });
    mockLockAcquired();
    mockSuccessfulRound(0);
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(5);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'manual_stop', autoStopRequested: false },
    });
  });

  it('stops with reason "error" and still releases the lock when a round throws', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(9);
    vi.mocked(aiAnalysisService.analyzeJob).mockRejectedValue(new Error('Gemini circuit open'));

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 9);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false },
    });
  });
});
