/**
 * PdfAutoModeController -- start/status/stop endpoints for the auto-
 * remediation loop. Two parallel paths: a ComparisonTrial-linked job (the
 * original, research-tooling behavior -- every test under "trial-linked
 * job" below is unchanged from before this file supported a second path)
 * and any other job the caller owns (the new, production path -- every
 * test under "job-native (no trial) path" below).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: { findUnique: vi.fn(), update: vi.fn() },
    pdfAutoRemediationRun: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    job: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
// resolveColorContrastMode is a pure function the controller uses to
// normalize the status response -- keep the real implementation via
// importOriginal so this test isn't duplicating its allowlist logic; only
// autoRemediationLoopService itself (the class with I/O side effects) needs
// mocking.
vi.mock('../../../src/services/pdf/auto-remediation-loop.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/pdf/auto-remediation-loop.service')>();
  // Mutates the REAL singleton's methods in place (Object.assign onto the
  // same object `actual` already holds) rather than replacing
  // autoRemediationLoopService with a fresh plain object. The real,
  // unmocked enqueueOrRunAutoLoop (spread in via `...actual`) calls
  // `autoRemediationLoopService.startAutoLoop(...)` via a same-module
  // closure over this exact singleton -- replacing the export binding with
  // a new object would be invisible to that internal call (vi.mock only
  // rebinds what OTHER modules see on import, not a module's own
  // self-references), so the stub has to land on the same instance instead.
  Object.assign(actual.autoRemediationLoopService, {
    startAutoLoop: vi.fn(),
    reconcileIfOrphaned: vi.fn().mockResolvedValue(undefined),
    reconcileIfOrphanedJobRun: vi.fn().mockResolvedValue(undefined),
  });
  return actual;
});
// Queue availability -- the controller enqueues onto the worker process's
// auto-remediation queue when Redis/BullMQ is available, falling back to
// the original direct in-process call otherwise (local dev without Redis).
vi.mock('../../../src/queues', () => ({
  areQueuesAvailable: vi.fn(),
  getAutoRemediationQueue: vi.fn(),
}));
vi.mock('../../../src/services/pdf/auto-mode-budget-estimate.service', () => ({
  estimateBudgetForJob: vi.fn(),
}));
// getStatus resolves `pendingFullAutoMode` (whether Full Auto Mode is still
// expected to auto-start this job) whenever no run has started yet -- mock
// this instead of letting it hit the real tenant-settings Prisma read.
vi.mock('../../../src/services/pdf/ai-remediation-tenant-config.service', () => ({
  getEffectiveAiRemediationConfig: vi.fn(),
}));

import prisma from '../../../src/lib/prisma';
import { pdfAutoModeController } from '../../../src/controllers/pdf-auto-mode.controller';
import { autoRemediationLoopService, ComparisonTrialAutoRemediationDriver } from '../../../src/services/pdf/auto-remediation-loop.service';
import { getEffectiveAiRemediationConfig } from '../../../src/services/pdf/ai-remediation-tenant-config.service';
import { areQueuesAvailable, getAutoRemediationQueue } from '../../../src/queues';
import { estimateBudgetForJob } from '../../../src/services/pdf/auto-mode-budget-estimate.service';

const mockQueueAdd = vi.fn();

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1', tenantId: 'tenant-1', fullAutoMode: null, autoEscalateOnStall: null },
    body: {},
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

describe('PdfAutoModeController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: queues available, matching real deployed behavior. Individual
    // tests override this to false to exercise the in-process fallback.
    vi.mocked(areQueuesAvailable).mockReturnValue(true);
    vi.mocked(getAutoRemediationQueue).mockReturnValue({ add: mockQueueAdd } as any);
    mockQueueAdd.mockResolvedValue(undefined);
  });

  describe('start -- trial-linked job', () => {
    it('rejects with 400 when the trial is not in auto mode', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'manual', autoStatus: null } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
    });

    it('rejects with 409 when auto mode is already running', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: 'running' } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'AUTO_MODE_ALREADY_RUNNING' }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
    });

    it('reconciles an orphaned run (crashed process, e.g. a mid-deploy ECS drain) and allows a fresh start', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique)
        .mockResolvedValueOnce({ id: 'trial-1', mode: 'auto', autoStatus: 'running' } as any)
        .mockResolvedValueOnce({ id: 'trial-1', mode: 'auto', autoStatus: 'stopped', autoStopReason: 'error' } as any);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphaned).toHaveBeenCalledWith('trial-1');
      // jobId is unique per dispatch attempt (`${id}-${Date.now()}`), not the
      // bare trial id -- see enqueueOrRunAutoLoop's doc comment for why
      // (2026-10-14 incident: a stable jobId let a crashed run's wedged
      // BullMQ entry silently block every future start).
      expect(mockQueueAdd).toHaveBeenCalledWith('auto-remediation-trial-1', { kind: 'trial', id: 'trial-1' }, { jobId: expect.stringMatching(/^trial-1-\d+$/) });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next).not.toHaveBeenCalled();
    });

    /**
     * Real incident (Whiting_186772, 2026-11-20): a crashed round left the
     * remediation-cycle lock held but non-stale; every retry during that
     * window got back this endpoint's unconditional 202 "started" even
     * though the fire-and-forget loop silently did nothing (lock still
     * held). Checking the lock before responding fixes that.
     */
    it('rejects with 409 when the remediation-cycle lock is currently held (not stale)', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValueOnce({ id: 'trial-1', mode: 'auto', autoStatus: 'stopped' } as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
        remediationCycleLockedAt: new Date(),
        remediationCycleLockedBy: 'auto-mode',
        remediationCycleSource: 'auto_loop',
      } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'REMEDIATION_CYCLE_LOCK_HELD' }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('kicks off the loop and responds 202 when eligible, ignoring any request body (trial config is pre-set via the admin endpoint)', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: null } as any);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq({ body: { autoMaxRounds: 15 } as any }), res, next);

      expect(mockQueueAdd).toHaveBeenCalledWith('auto-remediation-trial-1', { kind: 'trial', id: 'trial-1' }, { jobId: expect.stringMatching(/^trial-1-\d+$/) });
      expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('falls back to calling startAutoLoop directly in-process when queues are unavailable (e.g. local dev without Redis)', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: null } as any);
      vi.mocked(areQueuesAvailable).mockReturnValue(false);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(new ComparisonTrialAutoRemediationDriver('trial-1'));
      expect(res.status).toHaveBeenCalledWith(202);
    });
  });

  describe('start -- job-native (no trial) path', () => {
    beforeEach(() => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);
    });

    it('upserts a PdfAutoRemediationRun with defaults and starts the loop when no body overrides are given', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1' },
        update: {},
      });
      expect(mockQueueAdd).toHaveBeenCalledWith('auto-remediation-run-1', { kind: 'jobRun', id: 'run-1' }, { jobId: expect.stringMatching(/^run-1-\d+$/) });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next).not.toHaveBeenCalled();
    });

    it('passes validated body overrides through to the upsert', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(
        makeReq({ body: { autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'disabled' } as any }),
        res,
        next
      );

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1', autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'disabled' },
        update: { autoMaxRounds: 5, autoCostLimitUsd: 1.5, autoColorContrastMode: 'disabled' },
      });
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('passes a validated autoAltTextMode body override through to the upsert -- the per-job "client supplies their own alt text" lever', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(
        makeReq({ body: { autoAltTextMode: 'guidance-only' } as any }),
        res,
        next
      );

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1', autoAltTextMode: 'guidance-only' },
        update: { autoAltTextMode: 'guidance-only' },
      });
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('passes a validated autoLinkTextMode body override through to the upsert -- previously had no per-run override at all', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(
        makeReq({ body: { autoLinkTextMode: 'apply-to-pdf' } as any }),
        res,
        next
      );

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1', autoLinkTextMode: 'apply-to-pdf' },
        update: { autoLinkTextMode: 'apply-to-pdf' },
      });
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('passes a validated autoBookmarkMode body override through to the upsert -- regenerateGenericBookmarkTitles is a real, proven fixer that had no per-run override either', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(
        makeReq({ body: { autoBookmarkMode: 'apply-to-pdf' } as any }),
        res,
        next
      );

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1', autoBookmarkMode: 'apply-to-pdf' },
        update: { autoBookmarkMode: 'apply-to-pdf' },
      });
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('rejects with 409 when auto mode is already running for this job', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({ id: 'run-1', jobId: 'job-1', autoStatus: 'running' } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'AUTO_MODE_ALREADY_RUNNING' }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
      expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the remediation-cycle lock is currently held (not stale) -- real incident, Whiting_186772, 2026-11-20', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'stopped' } as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
        remediationCycleLockedAt: new Date(),
        remediationCycleLockedBy: 'auto-mode',
        remediationCycleSource: 'auto_loop',
      } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'REMEDIATION_CYCLE_LOCK_HELD' }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
      expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
    });

    it('allows a fresh start once the lock has gone stale, even though the column is still non-null', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'stopped' } as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
        remediationCycleLockedAt: new Date(Date.now() - 25 * 60 * 1000), // 25 min ago, past STALE_LOCK_MS (20 min)
        remediationCycleLockedBy: 'auto-mode',
        remediationCycleSource: 'auto_loop',
      } as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1' } as any);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('reconciles an orphaned job-run and allows a fresh start', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique)
        .mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'running' } as any)
        .mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'stopped', autoStopReason: 'error' } as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphanedJobRun).toHaveBeenCalledWith('run-1');
      expect(mockQueueAdd).toHaveBeenCalledWith('auto-remediation-run-1', { kind: 'jobRun', id: 'run-1' }, { jobId: expect.stringMatching(/^run-1-\d+$/) });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('getStatus -- trial-linked job', () => {
    it('returns the trial\'s auto-mode fields', async () => {
      const startedAt = new Date('2026-10-15T01:00:00Z');
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({
        mode: 'auto',
        autoStatus: 'running',
        autoStopReason: null,
        autoStartedAt: startedAt,
        autoRoundsCompleted: 3,
        autoMaxRounds: 10,
        autoCostSpentUsd: 0.42,
        autoCostLimitUsd: 2.0,
        autoColorContrastMode: 'apply-to-pdf',
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'auto',
          autoStatus: 'running',
          autoStopReason: null,
          autoStartedAt: startedAt,
          autoRoundsCompleted: 3,
          autoMaxRounds: 10,
          autoCostSpentUsd: 0.42,
          autoCostLimitUsd: 2.0,
          autoColorContrastMode: 'apply-to-pdf',
          autoAltTextMode: null,
        },
      });
    });

    it('reconciles an orphaned run before reporting status', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique)
        .mockResolvedValueOnce({
          id: 'trial-1', mode: 'auto', autoStatus: 'running', autoStopReason: null,
          autoRoundsCompleted: 6, autoMaxRounds: 10, autoCostSpentUsd: 0.5, autoCostLimitUsd: 2.0, autoColorContrastMode: null,
        } as any)
        .mockResolvedValueOnce({
          id: 'trial-1', mode: 'auto', autoStatus: 'stopped', autoStopReason: 'error',
          autoRoundsCompleted: 6, autoMaxRounds: 10, autoCostSpentUsd: 0.5, autoCostLimitUsd: 2.0, autoColorContrastMode: null,
        } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphaned).toHaveBeenCalledWith('trial-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ autoStatus: 'stopped', autoStopReason: 'error' }) })
      );
    });

    it('reports null (inherited) for a null or unrecognized stored autoColorContrastMode, not the raw value (CodeRabbit finding)', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({
        mode: 'auto',
        autoStatus: 'running',
        autoStopReason: null,
        autoRoundsCompleted: 3,
        autoMaxRounds: 10,
        autoCostSpentUsd: 0.42,
        autoCostLimitUsd: 2.0,
        autoColorContrastMode: 'not-a-real-mode',
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ autoColorContrastMode: null }) })
      );
    });
  });

  describe('getStatus -- job-native (no trial) path', () => {
    beforeEach(() => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: false, autoEscalateOnStallDefault: false } as any);
    });

    it('reports "never run" defaults (200, not 404) when no run row exists yet -- the expected common state for a job nobody has started Auto Mode on', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(getEffectiveAiRemediationConfig).toHaveBeenCalledWith('tenant-1');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'manual',
          autoStatus: null,
          autoStopReason: null,
          autoStartedAt: null,
          autoRoundsCompleted: 0,
          autoMaxRounds: 10,
          autoCostSpentUsd: 0,
          autoCostLimitUsd: 2.0,
          autoColorContrastMode: null,
          autoAltTextMode: null,
          autoLinkTextMode: null,
          autoBookmarkMode: null,
          autoStallEscalated: false,
          pendingFullAutoMode: false,
          fullAutoModeEffective: false,
          autoEscalateOnStallEffective: false,
          autoLoopLastError: null,
        },
      });
    });

    it('reports pendingFullAutoMode: true when this job\'s own upload-time override is true, even with the tenant default off', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq({ job: { id: 'job-1', tenantId: 'tenant-1', fullAutoMode: true } as any }), res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pendingFullAutoMode: true }) })
      );
    });

    it('reports pendingFullAutoMode: true when the tenant default is on and this job has no override', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pendingFullAutoMode: true }) })
      );
    });

    it('reports pendingFullAutoMode once a run row exists but hasn\'t started yet (autoStatus still null), using the row\'s own stored overrides rather than hardcoded defaults', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
        autoStatus: null,
        autoStopReason: null,
        autoStartedAt: null,
        autoRoundsCompleted: 0,
        autoMaxRounds: 7,
        autoCostSpentUsd: 0,
        autoCostLimitUsd: 1.5,
        autoColorContrastMode: null,
        autoLinkTextMode: null,
        autoBookmarkMode: null,
        autoStallEscalated: false,
      } as any);
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true, autoEscalateOnStallDefault: false } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'auto',
          autoStatus: null,
          autoStopReason: null,
          autoStartedAt: null,
          autoRoundsCompleted: 0,
          autoMaxRounds: 7,
          autoCostSpentUsd: 0,
          autoCostLimitUsd: 1.5,
          autoColorContrastMode: null,
          autoAltTextMode: null,
          autoLinkTextMode: null,
          autoBookmarkMode: null,
          autoStallEscalated: false,
          pendingFullAutoMode: true,
          fullAutoModeEffective: true,
          autoEscalateOnStallEffective: false,
          autoLoopLastError: null,
        },
      });
    });

    it('also resolves fullAutoModeEffective/autoEscalateOnStallEffective once a run has actually started or stopped, even though pendingFullAutoMode no longer applies -- previously neither flag was visible anywhere during or after a run, only pre-start', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
        autoStatus: 'stopped',
        autoStopReason: 'converged',
        autoRoundsCompleted: 3,
        autoMaxRounds: 10,
        autoCostSpentUsd: 0.2,
        autoCostLimitUsd: 2.0,
        autoColorContrastMode: null,
      } as any);
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true, autoEscalateOnStallDefault: true } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(getEffectiveAiRemediationConfig).toHaveBeenCalledWith('tenant-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fullAutoModeEffective: true, autoEscalateOnStallEffective: true }),
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.not.objectContaining({ pendingFullAutoMode: expect.anything() }) })
      );
    });

    it('returns the run\'s auto-mode fields once a run exists', async () => {
      const startedAt = new Date('2026-10-15T01:00:00Z');
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
        autoStatus: 'running',
        autoStopReason: null,
        autoStartedAt: startedAt,
        autoRoundsCompleted: 2,
        autoMaxRounds: 5,
        autoCostSpentUsd: 0.1,
        autoCostLimitUsd: 1.5,
        autoColorContrastMode: 'disabled',
        autoLinkTextMode: 'apply-to-pdf',
        autoBookmarkMode: 'guidance-only',
        autoStallEscalated: true,
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'auto',
          autoStatus: 'running',
          autoStopReason: null,
          autoStartedAt: startedAt,
          autoRoundsCompleted: 2,
          autoMaxRounds: 5,
          autoCostSpentUsd: 0.1,
          autoCostLimitUsd: 1.5,
          autoColorContrastMode: 'disabled',
          autoAltTextMode: null,
          autoLinkTextMode: 'apply-to-pdf',
          autoBookmarkMode: 'guidance-only',
          autoStallEscalated: true,
          fullAutoModeEffective: false,
          autoEscalateOnStallEffective: false,
          autoLoopLastError: null,
        },
      });
    });

    it('surfaces autoLoopLastError from job.output when the loop\'s last stop was a genuine error (real incident, 2026-11-27: a NUL-byte Postgres rejection only ever visible in CloudWatch before this)', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
        autoStatus: 'stopped',
        autoStopReason: 'error',
        autoStartedAt: new Date('2026-11-27T19:33:58Z'),
        autoRoundsCompleted: 0,
        autoMaxRounds: 10,
        autoCostSpentUsd: 0.12,
        autoCostLimitUsd: 2,
        autoColorContrastMode: null,
        autoLinkTextMode: null,
        autoBookmarkMode: null,
        autoStallEscalated: false,
      } as any);
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        output: {
          autoLoopLastError: {
            message: 'invalid input syntax for type json | at Object.extractText (text-extractor.service.ts:255:1)',
            at: '2026-11-27T20:29:50.006Z',
            roundsCompleted: 0,
            costSpentUsd: 0.12,
          },
        },
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            autoStopReason: 'error',
            autoLoopLastError: expect.objectContaining({ message: expect.stringContaining('invalid input syntax for type json') }),
          }),
        })
      );
    });

    it('reconciles an orphaned job-run before reporting status', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique)
        .mockResolvedValueOnce({
          id: 'run-1', autoStatus: 'running', autoStopReason: null,
          autoRoundsCompleted: 6, autoMaxRounds: 10, autoCostSpentUsd: 0.5, autoCostLimitUsd: 2.0, autoColorContrastMode: null,
        } as any)
        .mockResolvedValueOnce({
          id: 'run-1', autoStatus: 'stopped', autoStopReason: 'error',
          autoRoundsCompleted: 6, autoMaxRounds: 10, autoCostSpentUsd: 0.5, autoCostLimitUsd: 2.0, autoColorContrastMode: null,
        } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphanedJobRun).toHaveBeenCalledWith('run-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ autoStatus: 'stopped', autoStopReason: 'error' }) })
      );
    });
  });

  describe('stop -- trial-linked job', () => {
    it('is a no-op (200, no update) when auto mode is not running', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', autoStatus: 'stopped' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.comparisonTrial.update).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('reconciles an already-orphaned run and reports it as not running, without setting autoStopRequested', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique)
        .mockResolvedValueOnce({ id: 'trial-1', autoStatus: 'running' } as any)
        .mockResolvedValueOnce({ id: 'trial-1', autoStatus: 'stopped', autoStopReason: 'error' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphaned).toHaveBeenCalledWith('trial-1');
      expect(prisma.comparisonTrial.update).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining('not currently running') }) })
      );
    });

    it('sets autoStopRequested when auto mode is running', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', autoStatus: 'running' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { autoStopRequested: true },
      });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('stop -- job-native (no trial) path', () => {
    beforeEach(() => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);
    });

    it('is a no-op (200) when no run row exists at all', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.pdfAutoRemediationRun.update).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('is a no-op (200, no update) when the run exists but is not running', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({ id: 'run-1', autoStatus: 'stopped' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.pdfAutoRemediationRun.update).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('sets autoStopRequested when auto mode is running', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({ id: 'run-1', autoStatus: 'running' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.pdfAutoRemediationRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: { autoStopRequested: true },
      });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('getBudgetEstimate', () => {
    it('returns the estimate from the service as-is', async () => {
      const estimate = { estimatedCostUsd: 3.5, confidence: 'medium' as const, sampleSize: 8, basedOnIssueCount: 350 };
      vi.mocked(estimateBudgetForJob).mockResolvedValue(estimate);
      const res = makeRes();

      await pdfAutoModeController.getBudgetEstimate(makeReq(), res, next);

      expect(estimateBudgetForJob).toHaveBeenCalledWith('job-1');
      expect(res.json).toHaveBeenCalledWith({ success: true, data: estimate });
    });

    it('forwards a service error to next() rather than throwing', async () => {
      const error = new Error('db down');
      vi.mocked(estimateBudgetForJob).mockRejectedValue(error);
      const res = makeRes();

      await pdfAutoModeController.getBudgetEstimate(makeReq(), res, next);

      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe('getJobSettings / updateJobSettings', () => {
    beforeEach(() => {
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({
        fullAutoModeDefault: false,
        autoEscalateOnStallDefault: false,
        fullQCDefault: false,
        epubFromPdfDefault: false,
      } as any);
    });

    it('getJobSettings reports override/tenantDefault/effective for all three per-job overrides', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        fullAutoMode: true, autoEscalateOnStall: null, fullQC: true, produceAccessibleEpub: true, epubIsbn: '9780306406157',
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getJobSettings(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          fullAutoMode: { override: true, tenantDefault: false, effective: true },
          autoEscalateOnStall: { override: null, tenantDefault: false, effective: false },
          fullQC: { override: true, tenantDefault: false, effective: true },
          produceAccessibleEpub: { override: true, tenantDefault: false, effective: true },
          epubIsbn: '9780306406157',
        },
      });
    });

    it('getJobSettings resolves a null override against the tenant default', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        fullAutoMode: null, autoEscalateOnStall: null, fullQC: null, produceAccessibleEpub: null, epubIsbn: null,
      } as any);
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({
        fullAutoModeDefault: true,
        autoEscalateOnStallDefault: true,
        fullQCDefault: true,
        epubFromPdfDefault: true,
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getJobSettings(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          fullAutoMode: { override: null, tenantDefault: true, effective: true },
          autoEscalateOnStall: { override: null, tenantDefault: true, effective: true },
          fullQC: { override: null, tenantDefault: true, effective: true },
          produceAccessibleEpub: { override: null, tenantDefault: true, effective: true },
          epubIsbn: null,
        },
      });
    });

    it('getJobSettings forwards a not-found job to next() as a 404 AppError', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);
      const res = makeRes();

      await pdfAutoModeController.getJobSettings(makeReq(), res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(res.json).not.toHaveBeenCalled();
    });

    it('updateJobSettings persists only the fields present in the body, leaving the other untouched', async () => {
      vi.mocked(prisma.job.update).mockResolvedValue({ fullAutoMode: true, autoEscalateOnStall: null } as any);
      const res = makeRes();

      await pdfAutoModeController.updateJobSettings(makeReq({ body: { fullAutoMode: true } as any }), res, next);

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { fullAutoMode: true },
        select: { fullAutoMode: true, autoEscalateOnStall: true },
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          fullAutoMode: { override: true, tenantDefault: false, effective: true },
          autoEscalateOnStall: { override: null, tenantDefault: false, effective: false },
        },
      });
    });

    it('updateJobSettings can explicitly reset an override back to null (inherit tenant default), distinct from omitting it', async () => {
      vi.mocked(prisma.job.update).mockResolvedValue({ fullAutoMode: null, autoEscalateOnStall: true } as any);
      const res = makeRes();

      await pdfAutoModeController.updateJobSettings(
        makeReq({ body: { fullAutoMode: null, autoEscalateOnStall: true } as any }),
        res,
        next
      );

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { fullAutoMode: null, autoEscalateOnStall: true },
        select: { fullAutoMode: true, autoEscalateOnStall: true },
      });
    });

    it('updateJobSettings forwards a db error to next() rather than throwing', async () => {
      const error = new Error('db down');
      vi.mocked(prisma.job.update).mockRejectedValue(error);
      const res = makeRes();

      await pdfAutoModeController.updateJobSettings(makeReq({ body: {} as any }), res, next);

      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe('updateJobEpubSettings', () => {
    const pdfJob = { id: 'job-1', tenantId: 'tenant-1', type: 'PDF_ACCESSIBILITY' };

    beforeEach(() => {
      vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ epubFromPdfDefault: false } as any);
    });

    it('turns the EPUB flag on and stores a normalised ISBN', async () => {
      vi.mocked(prisma.job.update).mockResolvedValue({ produceAccessibleEpub: true, epubIsbn: '9780306406157' } as any);
      const res = makeRes();

      await pdfAutoModeController.updateJobEpubSettings(
        makeReq({ job: pdfJob as any, body: { produceAccessibleEpub: true, epubIsbn: '978-0-306-40615-7' } as any }),
        res,
        next,
      );

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { produceAccessibleEpub: true, epubIsbn: '9780306406157' },
        select: { produceAccessibleEpub: true, epubIsbn: true },
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          produceAccessibleEpub: { override: true, tenantDefault: false, effective: true },
          epubIsbn: '9780306406157',
        },
      });
    });

    it('leaves omitted fields untouched and can reset the flag to the tenant default', async () => {
      vi.mocked(prisma.job.update).mockResolvedValue({ produceAccessibleEpub: null, epubIsbn: null } as any);

      await pdfAutoModeController.updateJobEpubSettings(
        makeReq({ job: pdfJob as any, body: { produceAccessibleEpub: null } as any }),
        makeRes(),
        next,
      );

      expect(vi.mocked(prisma.job.update).mock.calls[0][0].data).toEqual({ produceAccessibleEpub: null });
    });

    it('clears the ISBN with null', async () => {
      vi.mocked(prisma.job.update).mockResolvedValue({ produceAccessibleEpub: null, epubIsbn: null } as any);

      await pdfAutoModeController.updateJobEpubSettings(
        makeReq({ job: pdfJob as any, body: { epubIsbn: null } as any }),
        makeRes(),
        next,
      );

      expect(vi.mocked(prisma.job.update).mock.calls[0][0].data).toEqual({ epubIsbn: null });
    });

    it('rejects an ISBN with a bad check digit without writing anything', async () => {
      const res = makeRes();

      await pdfAutoModeController.updateJobEpubSettings(
        makeReq({ job: pdfJob as any, body: { epubIsbn: '978-0-306-40615-8' } as any }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, code: 'INVALID_EPUB_ISBN' }));
      expect(prisma.job.update).not.toHaveBeenCalled();
    });

    it('refuses non-PDF jobs', async () => {
      await pdfAutoModeController.updateJobEpubSettings(
        makeReq({ job: { ...pdfJob, type: 'EPUB_ACCESSIBILITY' } as any, body: { produceAccessibleEpub: true } as any }),
        makeRes(),
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, code: 'NOT_A_PDF_JOB' }));
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
  });
});
