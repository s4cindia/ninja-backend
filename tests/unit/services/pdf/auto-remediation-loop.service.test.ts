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

// $transaction invokes its callback against a `tx` that shares the SAME
// comparisonTrial.updateMany/$queryRaw mock functions as the top-level
// client, matching the established pattern in
// tests/unit/controllers/mark-complete.controller.test.ts -- so a test can
// assert via prisma.comparisonTrial.updateMany regardless of whether the
// real code called it through `tx` or directly. vi.hoisted is required here
// (not just naming these `mock*`) since vi.mock's factory is hoisted above
// regular top-level const declarations.
const { mockComparisonTrialUpdateMany, mockPdfAutoRemediationRunUpdateMany, mockQueryRaw } = vi.hoisted(() => ({
  mockComparisonTrialUpdateMany: vi.fn(),
  mockPdfAutoRemediationRunUpdateMany: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: mockComparisonTrialUpdateMany },
    pdfAutoRemediationRun: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: mockPdfAutoRemediationRunUpdateMany },
    job: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    aiAnalysis: { updateMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    $queryRaw: mockQueryRaw,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: mockQueryRaw,
        comparisonTrial: { updateMany: mockComparisonTrialUpdateMany },
        pdfAutoRemediationRun: { updateMany: mockPdfAutoRemediationRunUpdateMany },
      }),
  },
}));
vi.mock('../../../../src/services/pdf/ai-analysis.service');
vi.mock('../../../../src/services/pdf/pdf-reaudit.service');
vi.mock('../../../../src/services/pdf/remediation-cycle-lock.service');
vi.mock('../../../../src/services/pdf/remediation-cycle-history.service');
vi.mock('../../../../src/services/storage/file-storage.service');
vi.mock('../../../../src/services/notification/notification.service');
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { logger } from '../../../../src/lib/logger';
import { autoRemediationLoopService, ComparisonTrialAutoRemediationDriver, JobAutoRemediationDriver, describeAutoLoopStop } from '../../../../src/services/pdf/auto-remediation-loop.service';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { pdfReauditService } from '../../../../src/services/pdf/pdf-reaudit.service';
import { remediationCycleLockService } from '../../../../src/services/pdf/remediation-cycle-lock.service';
import { notificationService } from '../../../../src/services/notification/notification.service';
import { remediationCycleHistoryService } from '../../../../src/services/pdf/remediation-cycle-history.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';

function makeTrial(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trial-1',
    ninjaJobId: 'job-1',
    mode: 'auto',
    autoMaxRounds: 10,
    autoCostLimitUsd: 2.0,
    autoRoundsCompleted: 0,
    autoStopRequested: false,
    autoColorContrastMode: null,
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    jobId: 'job-1',
    autoMaxRounds: 10,
    autoCostLimitUsd: 2.0,
    autoRoundsCompleted: 0,
    autoStopRequested: false,
    autoColorContrastMode: null,
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

type ColorContrastMode = 'guidance-only' | 'disabled' | 'apply-to-pdf';

/** A round that finds `actionableCount` suggestions, applies all of them
 * successfully, and re-audits cleanly. `colorContrastMode` is analyzeJob's
 * own *resolved effective* mode (what reconciliation keys off), independent
 * of whatever override the trial itself carries -- most tests don't care
 * about it and leave it undefined, which triggers neither reconciliation
 * branch, same as an effective 'apply-to-pdf'. */
function mockProductiveRound(actionableCount: number, costUsd = 0, colorContrastMode?: ColorContrastMode) {
  vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0, colorContrastMode } as any);
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
 * genuine convergence signal; apply/reaudit are never reached. See
 * mockProductiveRound's doc comment for what `colorContrastMode` means. */
function mockEmptyRound(colorContrastMode?: ColorContrastMode) {
  vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValueOnce({ analyzed: 0, skipped: 0, colorContrastMode } as any);
  vi.mocked(prisma.aiAnalysis.count).mockResolvedValueOnce(0);
}

describe('describeAutoLoopStop', () => {
  it('maps converged to a JOB_COMPLETED success notification', () => {
    const result = describeAutoLoopStop('converged', '"doc.pdf"', 3, 0.42, undefined);
    expect(result.type).toBe('JOB_COMPLETED');
    expect(result.title).toBe('Auto Mode finished');
    expect(result.message).toContain('"doc.pdf"');
    expect(result.message).toContain('3 rounds');
    expect(result.message).toContain('$0.42');
  });

  it('maps round_limit and budget_limit to SYSTEM_ALERT, not a failure', () => {
    const roundLimit = describeAutoLoopStop('round_limit', '"doc.pdf"', 10, 2.0, undefined);
    expect(roundLimit.type).toBe('SYSTEM_ALERT');
    expect(roundLimit.title).toContain('round limit');

    const budgetLimit = describeAutoLoopStop('budget_limit', '"doc.pdf"', 5, 2.0, undefined);
    expect(budgetLimit.type).toBe('SYSTEM_ALERT');
    expect(budgetLimit.title).toContain('budget limit');
  });

  it('maps stalled to SYSTEM_ALERT', () => {
    const result = describeAutoLoopStop('stalled', '"doc.pdf"', 4, 0.10, undefined);
    expect(result.type).toBe('SYSTEM_ALERT');
    expect(result.title).toContain('no further progress');
  });

  it('maps error to JOB_FAILED and includes the real error message when present', () => {
    const result = describeAutoLoopStop('error', '"doc.pdf"', 1, 0.01, 'Prisma connection lost');
    expect(result.type).toBe('JOB_FAILED');
    expect(result.message).toContain('Prisma connection lost');
  });

  it('falls back to a generic error message when none was captured', () => {
    const result = describeAutoLoopStop('error', '"doc.pdf"', 0, 0, undefined);
    expect(result.type).toBe('JOB_FAILED');
    expect(result.message).toContain('unexpected error');
  });

  it('uses singular "round" for exactly one round', () => {
    const result = describeAutoLoopStop('converged', '"doc.pdf"', 1, 0.01, undefined);
    expect(result.message).toContain('1 round ');
    expect(result.message).not.toContain('1 rounds');
  });
});

describe('autoRemediationLoopService.startAutoLoop', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) -- also drains any unconsumed
    // mockResolvedValueOnce queue from a previous test, which clearAllMocks
    // leaves in place and would otherwise leak into the next test.
    vi.resetAllMocks();
  });

  it('does nothing if the trial is not in auto mode', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ mode: 'manual' }) as any);

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(remediationCycleLockService.acquireLock).not.toHaveBeenCalled();
  });

  it('does nothing if the remediation lock cannot be acquired', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' } as any);
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: false } as any);

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.update).not.toHaveBeenCalled();
  });

  it('converges immediately when round 1 itself finds nothing actionable, without applying or re-auditing', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(7);
    mockJobFound();
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(aiAnalysisService.applyApprovedSuggestions).not.toHaveBeenCalled();
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 7);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
    // A round that found nothing to do doesn't count toward the ceiling --
    // only the initial reset (autoRoundsCompleted: 0) and the final stop
    // update happen, no separate per-round bookkeeping update in between.
    expect(prisma.comparisonTrial.update).toHaveBeenCalledTimes(2);

    // Operator notification: converged is a genuine success.
    await vi.waitFor(() => expect(notificationService.createNotification).toHaveBeenCalledTimes(1));
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'JOB_COMPLETED', title: 'Auto Mode finished' })
    );
  });

  it('sums Claude cost together with Gemini cost, not just Gemini alone (real bug: autoCostSpentUsd used to silently drop Claude-routed suggestion cost from the same round)', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired();
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
    vi.mocked(prisma.aiAnalysis.count)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(aiAnalysisService.applyApprovedSuggestions).mockResolvedValueOnce({
      applied: 1,
      failed: 0,
      errors: [],
      modifiedBuffer: Buffer.from('pdf'),
      fileName: 'doc.pdf',
    });
    mockReauditSuccess();
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      id: 'job-1',
      tenantId: 'tenant-1',
      output: { aiAnalysisStats: { gemini: { estimatedCostUsd: 0.1 }, claude: { estimatedCostUsd: 0.05 } } },
    } as any);

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoRoundsCompleted: 1, autoCostSpentUsd: expect.closeTo(0.15, 10) },
    });
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(aiAnalysisService.applyApprovedSuggestions).toHaveBeenCalledTimes(1);
    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoRoundsCompleted: 1, autoCostSpentUsd: 0.1 },
    });
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('logs this round\'s AI cost on the ai_analysis history event (Operational Reports Group 2)', async () => {
    // Same fixture as the regression test above (234 actionable, $0.10
    // spent) -- just asserting a different, additive side effect: the
    // costUsd field on the already-logged ai_analysis event, read fresh off
    // job.output.aiAnalysisStats the same way the outer loop's own
    // autoCostSpentUsd accumulation does (duplicated read, not shared, by
    // design -- see getRoundAiCostUsd's doc comment).
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(7);
    mockProductiveRound(234, 0.1);
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_analysis', cycleNumber: 7, costUsd: 0.1 })
    );
  });

  it('regression: does not converge while a leftover approved-but-unapplied row from a partial apply failure remains (CodeRabbit finding)', async () => {
    // Round 1: 10 actionable, but only 8 apply -- 2 stay stuck at 'approved'
    // (not a full stall since applied > 0, so this isn't caught by stall
    // detection). Round 2: analyzeJob finds no *new* pending suggestions,
    // but the actionable-count query (pending + approved) must still see
    // the 2 leftover approved rows and refuse to converge -- counting only
    // updateMany's newly-flipped-pending count would miss them entirely.
    // autoColorContrastMode: 'apply-to-pdf' so the stale-color-contrast-row
    // reconciliation (a separate concern, covered by its own tests below)
    // never fires here, keeping the mockResolvedValueOnce sequence below
    // paired 1:1 with the auto-approve updateMany calls this test cares about.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'apply-to-pdf' }) as any
    );
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(3);
    expect(aiAnalysisService.applyApprovedSuggestions).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it("passes the trial's autoColorContrastMode through to analyzeJob as a session override", async () => {
    // Auto mode used to always call analyzeJob with no overrides at all, so
    // contrast issues silently stayed guidance-only even when an operator
    // set colorContrastMode to 'apply-to-pdf' via the manual-mode checkbox --
    // that override never carried over into auto mode.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'apply-to-pdf' }) as any
    );
    mockLockAcquired();
    mockProductiveRound(1, 0);
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      colorContrastMode: 'apply-to-pdf',
    });
  });

  it('passes no override (inherits tenant/default config) when autoColorContrastMode is null -- the default for every trial', async () => {
    // A trial nobody has explicitly configured must behave exactly as auto
    // mode did before this override existed: no session override at all, so
    // analyzeJob's own merge falls through to the tenant's own
    // aiRemediation.colorContrastMode setting (a real, operator-configurable
    // value) or the backend default. A non-null default here would silently
    // clobber that tenant setting for every trial (CodeRabbit finding).
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoColorContrastMode: null }) as any);
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledWith('job-1', 'tenant-1', undefined);
  });

  it('treats an unrecognized stored autoColorContrastMode the same as null -- no override passed', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'not-a-real-mode' }) as any
    );
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledWith('job-1', 'tenant-1', undefined);
  });

  it('downgrades a stale pending/approved color-contrast-fix row when analyzeJob resolves guidance-only (Codex finding)', async () => {
    // A prior round (or a manual pass) left a color-contrast-fix row sitting
    // at applyMode 'apply-to-pdf'. analyzeJob only touches a row for an
    // issue it currently produces a suggestion for -- with colorContrastMode
    // now 'guidance-only', color-contrast issues never go through that path
    // this round, so the stale row would otherwise still be picked up and
    // applied by the actionable-count/auto-approve queries below, silently
    // overriding the switch away from apply-to-pdf.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'guidance-only' }) as any
    );
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound('guidance-only');

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(prisma.aiAnalysis.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        suggestionType: 'color-contrast-fix',
        applyMode: 'apply-to-pdf',
        status: { in: ['pending', 'approved'] },
      },
      data: { applyMode: 'guidance-only' },
    });
    expect(prisma.aiAnalysis.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes (not downgrades) a stale pending/approved color-contrast-fix row when analyzeJob resolves disabled (CodeRabbit finding)', async () => {
    // 'disabled' means fully suppressed -- downgrading to guidance-only
    // would still leave the row visible via GET /pdf/:jobId/ai-analysis and
    // counted toward the guidance-acknowledgment flow, contradicting what
    // "disabled" is supposed to mean.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'disabled' }) as any
    );
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound('disabled');

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(prisma.aiAnalysis.deleteMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        suggestionType: 'color-contrast-fix',
        status: { in: ['pending', 'approved'] },
      },
    });
    expect(prisma.aiAnalysis.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { applyMode: 'guidance-only' } })
    );
  });

  it('does not reconcile color-contrast-fix rows at all when analyzeJob resolves apply-to-pdf', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoColorContrastMode: 'apply-to-pdf' }) as any
    );
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound('apply-to-pdf');

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(prisma.aiAnalysis.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiAnalysis.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { applyMode: 'guidance-only' } })
    );
  });

  it('reconciles against analyzeJob\'s resolved effective mode, not the trial\'s raw override (Codex finding)', async () => {
    // The trial itself has no explicit override (null -- inheriting tenant
    // config), but the tenant's own aiRemediation.colorContrastMode happens
    // to be 'disabled'. analyzeJob resolves that and reports it back;
    // reconciliation must key off analyzeJob's *resolved* colorContrastMode
    // (not the trial's raw autoColorContrastMode, which is merely null here)
    // or a stale apply-to-pdf row from an earlier explicit override would
    // survive an operator reverting back to "inherit".
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoColorContrastMode: null }) as any);
    mockLockAcquired();
    mockJobFound();
    mockEmptyRound('disabled');

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledWith('job-1', 'tenant-1', undefined);
    expect(prisma.aiAnalysis.deleteMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        suggestionType: 'color-contrast-fix',
        status: { in: ['pending', 'approved'] },
      },
    });
  });

  it('excludes alt-text-decorative from both the actionable-count query and the auto-approve update', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired();
    mockProductiveRound(1, 0);
    mockEmptyRound(); // let it converge right after, so there's exactly one round to inspect

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'round_limit', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('stops at the budget ceiling once cumulative Gemini cost meets or exceeds the limit', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoCostLimitUsd: 1.0 }) as any);
    mockLockAcquired();
    mockProductiveRound(5, 1.5); // exceeds the $1.00 ceiling after round 1

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'budget_limit', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'budget_limit', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    // Stops well short of the round ceiling (10) -- after the stall
    // threshold, not after exhausting rounds.
    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'stalled', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  /**
   * Real incident (Math_Olszewski_PDF.pdf, 2026-10-20): round 1 resolved 344
   * issues; rounds 2 and 3 then each applied a small, non-zero number (2) of
   * genuinely new, unrelated suggestions while the re-audit showed ZERO net
   * progress both times (resolvedCount: 0, remainingCount: 948 unchanged) --
   * the same ~190 permanently-failing suggestions were re-approved and
   * re-attempted every round, net-cancelling against that trickle. The old
   * `applied === 0` stall check never fired (applied was 2, not 0), so the
   * loop ran a 3rd full paid round for zero benefit before exhausting the
   * cost ceiling instead of stopping distinctly as 'stalled'.
   */
  it('stops with reason "stalled" when rounds apply a non-zero trickle of suggestions but the re-audit confirms zero net resolved progress', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoMaxRounds: 10 }) as any);
    mockLockAcquired();
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 1, skipped: 0 } as any);
    vi.mocked(prisma.aiAnalysis.count).mockResolvedValue(948);
    vi.mocked(prisma.aiAnalysis.updateMany).mockResolvedValue({ count: 948 } as any);
    vi.mocked(aiAnalysisService.applyApprovedSuggestions).mockResolvedValue({
      applied: 2,
      failed: 190,
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
      metrics: { totalOriginal: 948, totalNew: 948, resolvedCount: 0, remainingCount: 948, regressionCount: 0, resolutionRate: 0 },
      reauditReport: { issues: [] } as any,
    } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1', output: {} } as any);

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    // Stops after STALL_ROUND_LIMIT (2) rounds, not the round ceiling (10) --
    // confirms resolvedCount, not the non-zero `applied` count, drives this.
    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(2);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'stalled', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(3);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
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

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(aiAnalysisService.analyzeJob).toHaveBeenCalledTimes(1);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'manual_stop', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });

    // Operator notification: deliberately NOT sent for manual_stop -- the
    // operator already knows, since they just did it themselves.
    await new Promise((resolve) => setImmediate(resolve));
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it('stops with reason "error" and still releases the lock when a round throws', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(9);
    mockJobFound();
    vi.mocked(aiAnalysisService.analyzeJob).mockRejectedValue(new Error('Gemini circuit open'));

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 9);
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });

    await vi.waitFor(() => expect(notificationService.createNotification).toHaveBeenCalledTimes(1));
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'JOB_FAILED', title: 'Auto Mode stopped on error' })
    );
  });

  it('logs an error and stops with zero rounds (not silently) when getRoundState() returns null right after getConfig() found the same record -- real incident, 2026-10-17: this branch previously logged nothing at all, indistinguishable from the "hang" every other PDF-batch investigation that session turned out NOT to be', async () => {
    let call = 0;
    vi.mocked(prisma.comparisonTrial.findUnique).mockImplementation(() => {
      call++;
      // 1st call: getConfig() succeeds. 2nd call: getRoundState() -- the
      // record has vanished.
      return Promise.resolve(call === 1 ? (makeTrial() as any) : null);
    });
    mockLockAcquired(9);
    mockJobFound();

    await autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('getRoundState() returned null'));
    expect(aiAnalysisService.analyzeJob).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 9);
  });

  it('still releases the lock even when writing the terminal trial status itself fails (Codex finding)', async () => {
    // Writing terminal status before releasing the lock (the fix for the
    // CodeRabbit/Codex ordering race above) would otherwise leak the lock
    // for the full 20-minute staleness window if that write throws -- the
    // heartbeat has already stopped, so nothing would renew it either.
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
    mockLockAcquired(9);
    mockJobFound();
    mockEmptyRound();
    // First update call is startAutoLoop's own "fresh run resets counters"
    // write, before the round loop even begins -- must succeed so the
    // rejection lands on the *terminal* write in the finally block instead.
    vi.mocked(prisma.comparisonTrial.update)
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error('DB connection reset'));

    // The write's own failure still propagates (the caller -- /auto-mode/start
    // -- already attaches a .catch() to this fire-and-forget call), but the
    // lock must not leak because of it.
    await expect(autoRemediationLoopService.startAutoLoop(new ComparisonTrialAutoRemediationDriver('trial-1'))).rejects.toThrow('DB connection reset');

    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 9);
  });
});

describe('autoRemediationLoopService.reconcileIfOrphaned', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does nothing when the trial is not marked running', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'stopped' }) as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(remediationCycleLockService.getLockStatus).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when the trial has no associated job', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoStatus: 'running', ninjaJobId: null }) as any
    );

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(remediationCycleLockService.getLockStatus).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a genuinely still-running loop alone (lock actively held, any source) -- fast-path skips the transaction entirely', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: true, source: 'auto_loop' } as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(remediationCycleLockService.getLockStatus).toHaveBeenCalledWith('job-1');
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.updateMany).not.toHaveBeenCalled();
  });

  it('leaves alone when the lock is held by a different source, e.g. a manual analyze_job action (Codex finding: reconciling here would let a client start a new run that then silently fails to acquire the still-valid lock)', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: true, source: 'analyze_job' } as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.updateMany).not.toHaveBeenCalled();
  });

  it("marks an orphaned run 'stopped'/'error' when the row-locked re-check confirms the lock is genuinely free", async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: null }]);
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(mockQueryRaw).toHaveBeenCalled();
    expect(prisma.comparisonTrial.updateMany).toHaveBeenCalledWith({
      where: { id: 'trial-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it("marks an orphaned run 'stopped'/'error' when the row-locked re-check confirms the lock is stale", async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date(Date.now() - 30 * 60 * 1000) }]);
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(prisma.comparisonTrial.updateMany).toHaveBeenCalledWith({
      where: { id: 'trial-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('backs off without writing when the row lock reveals a concurrent run acquired it while waiting (CodeRabbit/Codex race finding)', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    // By the time we won the FOR UPDATE row lock, a concurrent acquireLock
    // had already landed a fresh (non-stale) timestamp.
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date() }]);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(prisma.comparisonTrial.updateMany).not.toHaveBeenCalled();
  });

  it('logs an orphan_reconciled history event when it actually reconciles a stale run (Operational Reports Group 4)', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoStatus: 'running', autoRoundsCompleted: 3 }) as any
    );
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date(Date.now() - 30 * 60 * 1000) }]);
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 4, action: 'orphan_reconciled', source: 'watchdog', status: 'failed' })
    );
  });

  it('does not log an interruption event when the row lock reveals a concurrent run and nothing was actually reconciled', async () => {
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date() }]);

    await autoRemediationLoopService.reconcileIfOrphaned('trial-1');

    expect(remediationCycleHistoryService.logEvent).not.toHaveBeenCalled();
  });
});

// Direct, isolated coverage of the driver extracted from startAutoLoop's own
// former body -- every prisma call here should be byte-for-byte the same
// call/data shape startAutoLoop used to make directly against
// comparisonTrial, confirmed independently of the loop's own control flow
// (already covered end-to-end by the startAutoLoop tests above, which all
// pass unchanged with this driver wrapping the same trialId).
describe('ComparisonTrialAutoRemediationDriver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('describe() labels the trial for log lines', () => {
    expect(new ComparisonTrialAutoRemediationDriver('trial-1').describe()).toBe('trial trial-1');
  });

  describe('getConfig', () => {
    it('resolves jobId/tenantId when the trial exists, has a job, and is in auto mode', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' } as any);

      const config = await new ComparisonTrialAutoRemediationDriver('trial-1').getConfig();

      expect(prisma.comparisonTrial.findUnique).toHaveBeenCalledWith({ where: { id: 'trial-1' } });
      expect(prisma.job.findUnique).toHaveBeenCalledWith({ where: { id: 'job-1' } });
      expect(config).toEqual({ jobId: 'job-1', tenantId: 'tenant-1' });
    });

    it('returns null when the trial does not exist', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);

      expect(await new ComparisonTrialAutoRemediationDriver('trial-1').getConfig()).toBeNull();
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });

    it('returns null when the trial has no associated job', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ ninjaJobId: null }) as any);

      expect(await new ComparisonTrialAutoRemediationDriver('trial-1').getConfig()).toBeNull();
    });

    it('returns null when the trial is not in auto mode', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial({ mode: 'manual' }) as any);

      expect(await new ComparisonTrialAutoRemediationDriver('trial-1').getConfig()).toBeNull();
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });

    it('returns null when the associated job no longer exists', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(makeTrial() as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);

      expect(await new ComparisonTrialAutoRemediationDriver('trial-1').getConfig()).toBeNull();
    });
  });

  it('resetForNewRun writes the exact fresh-run reset payload startAutoLoop used to write directly', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    await new ComparisonTrialAutoRemediationDriver('trial-1').resetForNewRun(startedAt);

    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: {
        autoStatus: 'running',
        autoStopReason: null,
        autoStopRequested: false,
        autoRoundsCompleted: 0,
        autoCostSpentUsd: 0,
        autoStartedAt: startedAt,
        autoStoppedAt: null,
      },
    });
  });

  describe('getRoundState', () => {
    it('returns the per-round control values from the current trial row', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
        makeTrial({ autoStopRequested: true, autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'apply-to-pdf' }) as any
      );

      const state = await new ComparisonTrialAutoRemediationDriver('trial-1').getRoundState();

      expect(state).toEqual({
        autoStopRequested: true,
        autoMaxRounds: 5,
        autoCostLimitUsd: 1.5,
        autoColorContrastMode: 'apply-to-pdf',
      });
    });

    it('returns null when the trial has disappeared mid-run', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);

      expect(await new ComparisonTrialAutoRemediationDriver('trial-1').getRoundState()).toBeNull();
    });
  });

  it('recordRoundProgress writes rounds/cost exactly as startAutoLoop used to', async () => {
    await new ComparisonTrialAutoRemediationDriver('trial-1').recordRoundProgress(3, 0.42);

    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoRoundsCompleted: 3, autoCostSpentUsd: 0.42 },
    });
  });

  it('markStopped writes the exact terminal payload startAutoLoop used to write directly', async () => {
    const stoppedAt = new Date('2026-01-01T01:00:00Z');
    await new ComparisonTrialAutoRemediationDriver('trial-1').markStopped('converged', stoppedAt);

    expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
      where: { id: 'trial-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: stoppedAt },
    });
  });
});

// The production, non-trial path's own orphan-recovery -- a direct
// structural mirror of reconcileIfOrphaned above, targeting
// PdfAutoRemediationRun instead of ComparisonTrial.
describe('autoRemediationLoopService.reconcileIfOrphanedJobRun', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does nothing when the run is not marked running', async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun({ autoStatus: 'stopped' }) as any);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(remediationCycleLockService.getLockStatus).not.toHaveBeenCalled();
    expect(prisma.pdfAutoRemediationRun.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a genuinely still-running loop alone -- fast-path skips the transaction entirely', async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: true, source: 'auto_loop' } as any);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(remediationCycleLockService.getLockStatus).toHaveBeenCalledWith('job-1');
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(prisma.pdfAutoRemediationRun.updateMany).not.toHaveBeenCalled();
  });

  it("marks an orphaned run 'stopped'/'error' when the row-locked re-check confirms the lock is genuinely free", async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: null }]);
    mockPdfAutoRemediationRunUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(mockQueryRaw).toHaveBeenCalled();
    expect(prisma.pdfAutoRemediationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it("marks an orphaned run 'stopped'/'error' when the row-locked re-check confirms the lock is stale", async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date(Date.now() - 30 * 60 * 1000) }]);
    mockPdfAutoRemediationRunUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(prisma.pdfAutoRemediationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('backs off without writing when the row lock reveals a concurrent run acquired it while waiting', async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun({ autoStatus: 'running' }) as any);
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date() }]);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(prisma.pdfAutoRemediationRun.updateMany).not.toHaveBeenCalled();
  });

  it('logs an orphan_reconciled history event when it actually reconciles a stale run (Operational Reports Group 4)', async () => {
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(
      makeRun({ autoStatus: 'running', autoRoundsCompleted: 2 }) as any
    );
    vi.mocked(remediationCycleLockService.getLockStatus).mockResolvedValue({ inProgress: false } as any);
    mockQueryRaw.mockResolvedValue([{ remediationCycleLockedAt: new Date(Date.now() - 30 * 60 * 1000) }]);
    mockPdfAutoRemediationRunUpdateMany.mockResolvedValue({ count: 1 } as any);

    await autoRemediationLoopService.reconcileIfOrphanedJobRun('run-1');

    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 3, action: 'orphan_reconciled', source: 'watchdog', status: 'failed' })
    );
  });
});

// Direct, isolated coverage of the production, non-trial path's driver --
// a structural mirror of ComparisonTrialAutoRemediationDriver's own tests
// above, targeting PdfAutoRemediationRun instead. No `mode` field exists on
// this table (see the driver's own doc comment), so getConfig has one fewer
// branch than the trial driver's.
describe('JobAutoRemediationDriver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('describe() labels the job-run for log lines', () => {
    expect(new JobAutoRemediationDriver('run-1').describe()).toBe('job-run run-1');
  });

  describe('getConfig', () => {
    it('resolves jobId/tenantId when the run exists and has a job', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun() as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' } as any);

      const config = await new JobAutoRemediationDriver('run-1').getConfig();

      expect(prisma.pdfAutoRemediationRun.findUnique).toHaveBeenCalledWith({ where: { id: 'run-1' } });
      expect(prisma.job.findUnique).toHaveBeenCalledWith({ where: { id: 'job-1' } });
      expect(config).toEqual({ jobId: 'job-1', tenantId: 'tenant-1' });
    });

    it('returns null when the run does not exist', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);

      expect(await new JobAutoRemediationDriver('run-1').getConfig()).toBeNull();
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });

    it('returns null when the associated job no longer exists', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(makeRun() as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);

      expect(await new JobAutoRemediationDriver('run-1').getConfig()).toBeNull();
    });
  });

  it('resetForNewRun writes the exact fresh-run reset payload the trial driver uses', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    await new JobAutoRemediationDriver('run-1').resetForNewRun(startedAt);

    expect(prisma.pdfAutoRemediationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        autoStatus: 'running',
        autoStopReason: null,
        autoStopRequested: false,
        autoRoundsCompleted: 0,
        autoCostSpentUsd: 0,
        autoStartedAt: startedAt,
        autoStoppedAt: null,
      },
    });
  });

  describe('getRoundState', () => {
    it('returns the per-round control values from the current run row', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(
        makeRun({ autoStopRequested: true, autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'apply-to-pdf' }) as any
      );

      const state = await new JobAutoRemediationDriver('run-1').getRoundState();

      expect(state).toEqual({
        autoStopRequested: true,
        autoMaxRounds: 5,
        autoCostLimitUsd: 1.5,
        autoColorContrastMode: 'apply-to-pdf',
      });
    });

    it('returns null when the run has disappeared mid-run', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);

      expect(await new JobAutoRemediationDriver('run-1').getRoundState()).toBeNull();
    });
  });

  it('recordRoundProgress writes rounds/cost exactly as the trial driver does', async () => {
    await new JobAutoRemediationDriver('run-1').recordRoundProgress(3, 0.42);

    expect(prisma.pdfAutoRemediationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { autoRoundsCompleted: 3, autoCostSpentUsd: 0.42 },
    });
  });

  it('markStopped writes the exact terminal payload the trial driver uses', async () => {
    const stoppedAt = new Date('2026-01-01T01:00:00Z');
    await new JobAutoRemediationDriver('run-1').markStopped('converged', stoppedAt);

    expect(prisma.pdfAutoRemediationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { autoStatus: 'stopped', autoStopReason: 'converged', autoStopRequested: false, autoStoppedAt: stoppedAt },
    });
  });
});

// 2026-10-14 incident: a worker-service deploy SIGKILLed the task mid-round;
// autoStatus stayed at 'running' for ~11 hours because nothing polled the
// one endpoint that lazily reconciles it. forceStopForShutdown (called from
// the worker's SIGTERM handler) and reconcileAllOrphanedRuns (called from
// the watchdog interval) close that gap -- see their own doc comments in
// auto-remediation-loop.service.ts for the full reasoning.
describe('autoRemediationLoopService.forceStopForShutdown', () => {
  it('force-stops a running trial, unconditionally (no lock-staleness wait)', async () => {
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 1 });

    await autoRemediationLoopService.forceStopForShutdown('trial', 'trial-1');

    expect(mockComparisonTrialUpdateMany).toHaveBeenCalledWith({
      where: { id: 'trial-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('force-stops a running job-run', async () => {
    mockPdfAutoRemediationRunUpdateMany.mockResolvedValue({ count: 1 });

    await autoRemediationLoopService.forceStopForShutdown('jobRun', 'run-1');

    expect(mockPdfAutoRemediationRunUpdateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', autoStatus: 'running' },
      data: { autoStatus: 'stopped', autoStopReason: 'error', autoStopRequested: false, autoStoppedAt: expect.any(Date) },
    });
  });

  it('swallows a DB failure instead of throwing -- non-fatal, self-heals via lock staleness', async () => {
    mockComparisonTrialUpdateMany.mockRejectedValue(new Error('db down'));

    await expect(autoRemediationLoopService.forceStopForShutdown('trial', 'trial-1')).resolves.toBeUndefined();
  });

  it('logs a force_stopped history event for a trial it actually stopped (Operational Reports Group 4)', async () => {
    // This describe block has no beforeEach reset (the existing tests above
    // only ever use toHaveBeenCalledWith, which tolerates leaked call
    // history from earlier tests) -- clear explicitly here since this test
    // and the two below it DO care about call history.
    vi.clearAllMocks();
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 1 });
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoRoundsCompleted: 5 }) as any
    );

    await autoRemediationLoopService.forceStopForShutdown('trial', 'trial-1');

    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 6, action: 'force_stopped', source: 'shutdown', status: 'failed' })
    );
  });

  it('logs a force_stopped history event for a job-run it actually stopped (Operational Reports Group 4)', async () => {
    vi.clearAllMocks();
    mockPdfAutoRemediationRunUpdateMany.mockResolvedValue({ count: 1 });
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(
      makeRun({ autoRoundsCompleted: 1 }) as any
    );

    await autoRemediationLoopService.forceStopForShutdown('jobRun', 'run-1');

    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 2, action: 'force_stopped', source: 'shutdown', status: 'failed' })
    );
  });

  it('does not log an interruption event when nothing was actually running to stop', async () => {
    vi.clearAllMocks();
    mockComparisonTrialUpdateMany.mockResolvedValue({ count: 0 });

    await autoRemediationLoopService.forceStopForShutdown('trial', 'trial-1');

    expect(prisma.comparisonTrial.findUnique).not.toHaveBeenCalled();
    expect(remediationCycleHistoryService.logEvent).not.toHaveBeenCalled();
  });
});

describe('autoRemediationLoopService.reconcileAllOrphanedRuns', () => {
  it('reconciles every trial/job-run currently reporting autoStatus running', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([{ id: 'trial-1' }, { id: 'trial-2' }] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([{ id: 'run-1' }] as any);
    const reconcileSpy = vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(undefined);
    const reconcileRunSpy = vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphanedJobRun').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(prisma.comparisonTrial.findMany).toHaveBeenCalledWith({
      where: { autoStatus: 'running' },
      select: { id: true, ninjaJobId: true, autoStopRequested: true },
    });
    expect(prisma.pdfAutoRemediationRun.findMany).toHaveBeenCalledWith({
      where: { autoStatus: 'running' },
      select: { id: true, jobId: true, autoStopRequested: true },
    });
    expect(reconcileSpy).toHaveBeenCalledWith('trial-1');
    expect(reconcileSpy).toHaveBeenCalledWith('trial-2');
    expect(reconcileRunSpy).toHaveBeenCalledWith('run-1');

    reconcileSpy.mockRestore();
    reconcileRunSpy.mockRestore();
  });

  it('does not throw when an individual reconcile call fails', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([{ id: 'trial-1' }] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    const reconcileSpy = vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockRejectedValue(new Error('boom'));

    await expect(autoRemediationLoopService.reconcileAllOrphanedRuns()).resolves.toBeUndefined();

    reconcileSpy.mockRestore();
  });
});

// Real incident, 2026-10-29: a job's postRemediationStatus was stuck at
// 'pending' -- the process that applied its fixes died between the
// (synchronous) PDF save and the re-audit that was meant to follow it --
// leaving its audit report stale relative to a newer file already on
// storage. See reconcileStalePostRemediation's own doc comment for the
// full shape.
describe('autoRemediationLoopService.reconcileStalePostRemediation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockStuckJob(outputOverrides: Record<string, unknown> = {}) {
    vi.mocked(prisma.job.findMany).mockResolvedValue([{ id: 'job-1' }] as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      id: 'job-1',
      output: {
        postRemediationStatus: 'pending',
        fileName: 'doc.pdf',
        remediatedFileUrl: 's3://remediated/doc.pdf',
        ...outputOverrides,
      },
    } as any);
  }

  it('does nothing when no job has a stuck pending status', async () => {
    vi.mocked(prisma.job.findMany).mockResolvedValue([] as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(remediationCycleLockService.acquireLock).not.toHaveBeenCalled();
  });

  it('queries only jobs with a free-or-stale remediation-cycle lock, same threshold as reconcileIfOrphaned', async () => {
    vi.mocked(prisma.job.findMany).mockResolvedValue([] as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(prisma.job.findMany).toHaveBeenCalledWith({
      where: {
        output: { path: ['postRemediationStatus'], equals: 'pending' },
        OR: [
          { remediationCycleLockedAt: null },
          { remediationCycleLockedAt: { lt: expect.any(Date) } },
        ],
      },
      select: { id: true },
    });
  });

  it('skips a job when a legitimate cycle wins the lock first, without touching its data', async () => {
    mockStuckJob();
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: false } as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(prisma.job.update).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).not.toHaveBeenCalled();
  });

  it('skips and releases the lock when the re-check under the lock finds the status already resolved', async () => {
    vi.mocked(prisma.job.findMany).mockResolvedValue([{ id: 'job-1' }] as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      id: 'job-1',
      output: { postRemediationStatus: 'complete' },
    } as any);
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });

  it('skips and releases the lock when the job has no recorded remediated file to re-audit', async () => {
    mockStuckJob({ fileName: undefined, remediatedFileUrl: undefined });
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(fileStorageService.getRemediatedFile).not.toHaveBeenCalled();
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });

  it('skips and releases the lock when the remediated file is missing from storage', async () => {
    mockStuckJob();
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(null);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });

  it('re-audits the current file and marks postRemediationStatus complete on success', async () => {
    mockStuckJob();
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true,
      jobId: 'job-1',
      originalAuditId: 'job-1',
      reauditId: 'job-1-reaudit',
      fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] },
      metrics: { totalOriginal: 0, totalNew: 0, resolvedCount: 3, remainingCount: 1, regressionCount: 0, resolutionRate: 75 },
      reauditReport: { issues: [{ id: 'issue-1' }] } as any,
    } as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledWith('job-1', Buffer.from('pdf'), 'doc.pdf');
    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        output: expect.objectContaining({
          auditReport: { issues: [{ id: 'issue-1' }] },
          postRemediationStatus: 'complete',
          postRemediationAudit: expect.objectContaining({ resolved: 3, remaining: 1, regressions: 0, resolutionRate: 75 }),
        }),
      },
    });
    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 5, action: 'reaudit', source: 'watchdog', status: 'completed', triggeredBy: 'watchdog' })
    );
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });

  it('marks postRemediationStatus failed when the re-audit itself reports failure, without throwing', async () => {
    mockStuckJob();
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: false,
      jobId: 'job-1',
      originalAuditId: 'job-1',
      reauditId: '',
      fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] },
      metrics: { totalOriginal: 0, totalNew: 0, resolvedCount: 0, remainingCount: 0, regressionCount: 0, resolutionRate: 0 },
      error: 'audit failed',
    } as any);

    await autoRemediationLoopService.reconcileStalePostRemediation();

    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { output: expect.objectContaining({ postRemediationStatus: 'failed' }) },
    });
    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'audit failed' })
    );
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });

  it('still releases the lock when reauditAndCompare itself throws', async () => {
    mockStuckJob();
    vi.mocked(remediationCycleLockService.acquireLock).mockResolvedValue({ acquired: true, cycleNumber: 5 } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfReauditService.reauditAndCompare).mockRejectedValue(new Error('storage unavailable'));

    await expect(autoRemediationLoopService.reconcileStalePostRemediation()).resolves.toBeUndefined();

    expect(prisma.job.update).not.toHaveBeenCalled();
    expect(remediationCycleLockService.releaseLock).toHaveBeenCalledWith('job-1', 5);
  });
});

// Auto-resume after a genuinely reconciled crash (Operational Reports-
// adjacent reliability work, 2026-10-26 FMHE incident: a worker task died
// mid-reaudit, reconcileIfOrphaned correctly marked the round stopped/error,
// but nothing ever resumed it -- it sat for 9+ hours until someone noticed
// by hand). maybeAutoResume is private, so every test here drives it through
// reconcileAllOrphanedRuns, its only caller, with reconcileIfOrphaned/
// reconcileIfOrphanedJobRun stubbed to simulate "just found a genuine
// orphan" (returns true) vs. "nothing to do" (returns false).
describe('autoRemediationLoopService.maybeAutoResume (via reconcileAllOrphanedRuns)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-resumes a trial after a genuine crash-recovery, under every cap', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoRoundsCompleted: 2, autoCostSpentUsd: 0.5 }) as any
    );
    vi.mocked(remediationCycleHistoryService.listForJob).mockResolvedValue([] as any);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).toHaveBeenCalledWith(new ComparisonTrialAutoRemediationDriver('trial-1'));
  });

  it('auto-resumes a job-run after a genuine crash-recovery, under every cap', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([
      { id: 'run-1', jobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphanedJobRun').mockResolvedValue(true);
    vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(
      makeRun({ autoRoundsCompleted: 2, autoCostSpentUsd: 0.5 }) as any
    );
    vi.mocked(remediationCycleHistoryService.listForJob).mockResolvedValue([] as any);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).toHaveBeenCalledWith(new JobAutoRemediationDriver('run-1'));
  });

  it('does not auto-resume when reconcile found nothing to do (not a genuine orphan)', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(false);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.findUnique).not.toHaveBeenCalled();
  });

  it('does not auto-resume when a stop was requested before the crash was reconciled', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: true },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).not.toHaveBeenCalled();
    expect(prisma.comparisonTrial.findUnique).not.toHaveBeenCalled();
  });

  it('does not auto-resume when the round limit was already reached', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoMaxRounds: 10, autoRoundsCompleted: 10, autoCostSpentUsd: 0.5 }) as any
    );
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not auto-resume when the cost limit was already reached', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoCostLimitUsd: 2.0, autoCostSpentUsd: 2.0 }) as any
    );
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not auto-resume once the crash-recovery cap is exceeded, leaving it for manual review', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoRoundsCompleted: 2, autoCostSpentUsd: 0.5 }) as any
    );
    // 3 crash-recoveries already logged within the lookback window -- over
    // the MAX_AUTO_CRASH_RESUMES (2) cap.
    const now = Date.now();
    vi.mocked(remediationCycleHistoryService.listForJob).mockResolvedValue([
      { action: 'orphan_reconciled', startedAt: new Date(now - 1000) },
      { action: 'orphan_reconciled', startedAt: new Date(now - 2000) },
      { action: 'orphan_reconciled', startedAt: new Date(now - 3000) },
      { action: 'reaudit', startedAt: new Date(now - 4000) }, // unrelated action, must not count
    ] as any);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('ignores crash-recoveries outside the lookback window when checking the cap', async () => {
    vi.mocked(prisma.comparisonTrial.findMany).mockResolvedValue([
      { id: 'trial-1', ninjaJobId: 'job-1', autoStopRequested: false },
    ] as any);
    vi.mocked(prisma.pdfAutoRemediationRun.findMany).mockResolvedValue([] as any);
    vi.spyOn(autoRemediationLoopService, 'reconcileIfOrphaned').mockResolvedValue(true);
    vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(
      makeTrial({ autoRoundsCompleted: 2, autoCostSpentUsd: 0.5 }) as any
    );
    const now = Date.now();
    vi.mocked(remediationCycleHistoryService.listForJob).mockResolvedValue([
      // 3 old crashes, well outside the 1-hour lookback -- must not count
      // toward the cap.
      { action: 'orphan_reconciled', startedAt: new Date(now - 5 * 60 * 60 * 1000) },
      { action: 'orphan_reconciled', startedAt: new Date(now - 6 * 60 * 60 * 1000) },
      { action: 'orphan_reconciled', startedAt: new Date(now - 7 * 60 * 60 * 1000) },
    ] as any);
    const startSpy = vi.spyOn(autoRemediationLoopService, 'startAutoLoop').mockResolvedValue(undefined);

    await autoRemediationLoopService.reconcileAllOrphanedRuns();

    expect(startSpy).toHaveBeenCalledWith(new ComparisonTrialAutoRemediationDriver('trial-1'));
  });
});
