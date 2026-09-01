/**
 * Auto Remediation Loop Service
 *
 * Covers the loop's stop conditions (converged / round_limit / budget_limit /
 * manual_stop / stalled / error), the decorative-suggestion carve-out, and
 * that the remediation-cycle lock is always released regardless of how the
 * loop ends.
 *
 * Convergence is driven by a count of 'pending' + 'approved' (non-decorative,
 * apply-to-pdf) rows taken at the top of each round, before auto-approving
 * or applying -- not by re-querying state after applying. Two distinct
 * regressions are pinned here: (1) a round that finds and fully resolves
 * work must still let a subsequent round's fresh analysis run against the
 * resulting re-audit before concluding convergence (a real bug caught live:
 * the loop stopped after a single successful round even though hundreds of
 * issues remained unanalyzed); (2) counting only newly-flipped 'pending'
 * rows would miss a leftover 'approved'-but-never-applied row from an
 * earlier round's partial apply failure, wrongly reporting convergence with
 * real unapplied work still outstanding.
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

/** The initial job lookup (for tenantId) done once before the round loop
 * starts -- independent of whatever a round later mocks findUnique to
 * return for its own cost-accounting re-fetch. */
function mockJobFound() {
  vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1', output: {} } as any);
}

function mockReauditSuccess() {
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
}

/** A round that finds `actionableCount` suggestions, applies all of them
 * successfully, and re-audits cleanly. */
function mockProductiveRound(actionableCount: number, costUsd = 0) {
  vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
  vi.mocked(prisma.aiAnalysis.count).mockResolvedValueOnce(actionableCount);
  vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValueOnce({ count: actionableCount } as any);
  vi.mocked(aiAnalysisService.applyApprovedSuggestions).mockResolvedValueOnce({
    applied: actionableCount,
    failed: 0,
    errors: [],
    modifiedBuffer: Buffer.from('pdf'),
    fileName: 'doc.pdf',
  });
  mockReauditSuccess();
  vi.mocked(prisma.job.findUnique).mockResolvedValue({
    id: 'job-1',
    tenantId: 'tenant-1',
    output: { aiAnalysisStats: { gemini: { estimatedCostUsd: costUsd } } },
  } as any);
}

/** A round whose fresh analysis finds nothing actionable at all -- the
 * genuine convergence signal; apply/reaudit are never reached. */
function mockEmptyRound() {
  vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValueOnce({ analyzed: 0, skipped: 0 } as any);
  vi.mocked(prisma.aiAnalysis.count).mockResolvedValueOnce(0);
}

describe('autoRemediationLoopService.startAutoLoop', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) -- also drains any unconsumed
    // mockResolvedValueOnce queue from a previous test, which clearAllMocks
    // leaves in place and would otherwise leak into the next test.
    vi.resetAllMocks();
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

  it('converges immediately when round 1 itself finds nothing actionable, without applying or re-auditing', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(7);
    mockJobFound();
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(aiAnalysisService.applyApprovedSuggestions).not.toHaveBeenCalled();
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 7);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false },
    });
    // A round that found nothing to do doesn't count toward the ceiling --
    // only the initial reset (autoRoundsCompleted: 0) and the final stop
    // update happen, no separate per-round bookkeeping update in between.
    expect(prisma.comparisonTrial.update).toHaveBeenCalledTimes(2);
  });

  it('regression: keeps going past a fully-successful round 1 and only converges once a fresh round finds nothing (the exact bug caught live)', async () => {
    // Round 1: 234 actionable suggestions found, all applied, re-audit
    // succeeds (425 -> 400 issues, matching the live Altman trial). Round 2:
    // fresh analysis against the post-reaudit state finds nothing left.
    // Before the fix, the loop wrongly stopped as "converged" right after
    // round 1 by re-checking round 1's own (now fully-resolved) suggestions
    // instead of giving round 2's analysis a chance to run at all.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(7);
    mockProductiveRound(234, 0.1);
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(aiAnalysisService.applyApprovedSuggestions).toHaveBeenCalledTimes(1);
    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoRoundsCompleted: 1, autoCostSpentUsd: 0.1 },
    });
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false },
    });
  });

  it('regression: does not converge while a leftover approved-but-unapplied row from a partial apply failure remains (CodeRabbit finding)', async () => {
    // Round 1: 10 actionable, but only 8 apply -- 2 stay stuck at 'approved'
    // (not a full stall since applied > 0, so this isn't caught by stall
    // detection). Round 2: analyzeJob finds no *new* pending suggestions,
    // but the actionable-count query (pending + approved) must still see
    // the 2 leftover approved rows and refuse to converge -- counting only
    // updateMany's newly-flipped-pending count would miss them entirely.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(7);
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      id: 'job-1',
      tenantId: 'tenant-1',
      output: { aiAnalysisStats: { gemini: { estimatedCostUsd: 0 } } },
    } as any);
    vi.mocked(prisma.aiAnalysis.count)
      .mockResolvedValueOnce(10) // round 1: 10 actionable
      .mockResolvedValueOnce(2) // round 2: 2 leftover approved-but-unapplied remain
      .mockResolvedValueOnce(0); // round 3: those 2 finally applied, now converged
    vi.mocked(prisma.aiAnalysis.updateMany)
      .mockResolvedValueOnce({ count: 10 } as any) // round 1: 10 pending -> approved
      .mockResolvedValueOnce({ count: 0 } as any); // round 2: nothing new pending (the 2 are already 'approved')
    vi.mocked(aiAnalysisService.applyApprovedSuggestions)
      .mockResolvedValueOnce({
        applied: 8,
        failed: 2,
        errors: [{ issueId: 'a', suggestionType: 'heading-fix', reason: 'unhandled' }, { issueId: 'b', suggestionType: 'heading-fix', reason: 'unhandled' }],
        modifiedBuffer: Buffer.from('pdf'),
        fileName: 'doc.pdf',
      })
      .mockResolvedValueOnce({
        applied: 2,
        failed: 0,
        errors: [],
        modifiedBuffer: Buffer.from('pdf'),
        fileName: 'doc.pdf',
      });
    mockReauditSuccess();

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(3);
    expect(aiAnalysisService.applyApprovedSuggestions).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false },
    });
  });

  it('excludes alt-text-decorative from both the actionable-count query and the auto-approve update', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired();
    mockProductiveRound(1, 0);
    mockEmptyRound(); // let it converge right after, so there's exactly one round to inspect

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(prisma.aiAnalysis.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          suggestionType: { not: 'alt-text-decorative' },
          status: { in: ['pending', 'approved'] },
        }),
      })
    );
    expect(prisma.aiAnalysis.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ suggestionType: { not: 'alt-text-decorative' }, status: 'pending' }),
        data: { status: 'approved', approvedBy: 'auto-mode' },
      })
    );
  });

  it('stops at the round ceiling when suggestions never run out', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoMaxRounds: 2 }) as any);
    mockLockAcquired();
    mockProductiveRound(5, 0);
    mockProductiveRound(5, 0);

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
    mockProductiveRound(5, 1.5); // exceeds the $1.00 ceiling after round 1

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'budget_limit', autoStopRequested: false },
    });
  });

  it('accumulates cost across multiple rounds rather than overwriting it, stopping only once the running total crosses the ceiling', async () => {
    // Each round alone costs less than the $1.00 ceiling (0.6) -- only the
    // cumulative total across two rounds (1.2) should trip it. A version
    // that overwrote instead of accumulated would run indefinitely.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoCostLimitUsd: 1.0 }) as any);
    mockLockAcquired();
    mockProductiveRound(5, 0.6);
    mockProductiveRound(5, 0.6);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'budget_limit', autoStopRequested: false },
    });
  });

  it('stops with reason "stalled" after consecutive rounds find work but apply none of it, rather than exhausting the round ceiling', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoMaxRounds: 10 }) as any);
    mockLockAcquired();
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
    // Every round finds something to approve but nothing actually applies
    // (e.g. an unhandled suggestionType) -- applyApprovedSuggestions leaves
    // it sitting at 'approved', so the suggestion count never reaches 0 on
    // its own; only the stall counter should end this.
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(1);
    vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(aiAnalysisService.applyApprovedSuggestions).mockResolvedValue({ applied: 0, failed: 1, errors: [] });
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1', output: {} } as any);

    await autoRemediationLoopService.startAutoLoop('trial-1');

    // Stops well short of the round ceiling (10) -- after the stall
    // threshold, not after exhausting rounds.
    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'stalled', autoStopRequested: false },
    });
  });

  it('resets the stall counter once a round makes progress again', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired();
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
    vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1', output: {} } as any);
    // Round 1 stalls (applied: 0), round 2 makes progress, round 3's fresh
    // analysis finds nothing left -- a single stall must not carry over and
    // trip the threshold later.
    vi.mocked(aiAnalysisService.applyApprovedSuggestions)
      .mockResolvedValueOnce({ applied: 0, failed: 1, errors: [] })
      .mockResolvedValueOnce({
        applied: 1,
        failed: 0,
        errors: [],
        modifiedBuffer: Buffer.from('pdf'),
        fileName: 'doc.pdf',
      });
    mockReauditSuccess();
    vi.mocked(prisma.aiAnalysis.count)
      .mockResolvedValueOnce(1) // round 1: stalls
      .mockResolvedValueOnce(1) // round 2: applies successfully
      .mockResolvedValueOnce(0); // round 3: converged

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(3);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false },
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
    mockProductiveRound(5, 0);

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
    mockJobFound();
    vi.mocked(aiAnalysisService.analyzeJob).mockRejectedValue(new Error('Gemini circuit open'));

    await autoRemediationLoopService.startAutoLoop('trial-1');

    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 9);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false },
    });
  });
});
