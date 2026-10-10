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
  },
}));
// resolveColorContrastMode is a pure function the controller uses to
// normalize the status response -- keep the real implementation via
// importOriginal so this test isn't duplicating its allowlist logic; only
// autoRemediationLoopService itself (the class with I/O side effects) needs
// mocking.
vi.mock('../../../src/services/pdf/auto-remediation-loop.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/pdf/auto-remediation-loop.service')>();
  return {
    ...actual,
    autoRemediationLoopService: {
      startAutoLoop: vi.fn(),
      reconcileIfOrphaned: vi.fn().mockResolvedValue(undefined),
      reconcileIfOrphanedJobRun: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import prisma from '../../../src/lib/prisma';
import { pdfAutoModeController } from '../../../src/controllers/pdf-auto-mode.controller';
import { autoRemediationLoopService, ComparisonTrialAutoRemediationDriver, JobAutoRemediationDriver } from '../../../src/services/pdf/auto-remediation-loop.service';

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
    job: { id: 'job-1' },
    body: {},
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

describe('PdfAutoModeController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphaned).toHaveBeenCalledWith('trial-1');
      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(new ComparisonTrialAutoRemediationDriver('trial-1'));
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next).not.toHaveBeenCalled();
    });

    it('kicks off the loop and responds 202 when eligible, ignoring any request body (trial config is pre-set via the admin endpoint)', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: null } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq({ body: { autoMaxRounds: 15 } as any }), res, next);

      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(new ComparisonTrialAutoRemediationDriver('trial-1'));
      expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('start -- job-native (no trial) path', () => {
    beforeEach(() => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);
    });

    it('upserts a PdfAutoRemediationRun with defaults and starts the loop when no body overrides are given', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith({
        where: { jobId: 'job-1' },
        create: { jobId: 'job-1' },
        update: {},
      });
      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(new JobAutoRemediationDriver('run-1'));
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

    it('rejects with 409 when auto mode is already running for this job', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({ id: 'run-1', jobId: 'job-1', autoStatus: 'running' } as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'AUTO_MODE_ALREADY_RUNNING' }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
      expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
    });

    it('reconciles an orphaned job-run and allows a fresh start', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique)
        .mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'running' } as any)
        .mockResolvedValueOnce({ id: 'run-1', jobId: 'job-1', autoStatus: 'stopped', autoStopReason: 'error' } as any);
      vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(autoRemediationLoopService.reconcileIfOrphanedJobRun).toHaveBeenCalledWith('run-1');
      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(new JobAutoRemediationDriver('run-1'));
      expect(res.status).toHaveBeenCalledWith(202);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('getStatus -- trial-linked job', () => {
    it('returns the trial\'s auto-mode fields', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({
        mode: 'auto',
        autoStatus: 'running',
        autoStopReason: null,
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
          autoRoundsCompleted: 3,
          autoMaxRounds: 10,
          autoCostSpentUsd: 0.42,
          autoCostLimitUsd: 2.0,
          autoColorContrastMode: 'apply-to-pdf',
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
    });

    it('reports "never run" defaults (200, not 404) when no run row exists yet -- the expected common state for a job nobody has started Auto Mode on', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue(null as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'manual',
          autoStatus: null,
          autoStopReason: null,
          autoRoundsCompleted: 0,
          autoMaxRounds: 10,
          autoCostSpentUsd: 0,
          autoCostLimitUsd: 2.0,
          autoColorContrastMode: null,
        },
      });
    });

    it('returns the run\'s auto-mode fields once a run exists', async () => {
      vi.mocked(prisma.pdfAutoRemediationRun.findUnique).mockResolvedValue({
        autoStatus: 'running',
        autoStopReason: null,
        autoRoundsCompleted: 2,
        autoMaxRounds: 5,
        autoCostSpentUsd: 0.1,
        autoCostLimitUsd: 1.5,
        autoColorContrastMode: 'disabled',
      } as any);
      const res = makeRes();

      await pdfAutoModeController.getStatus(makeReq(), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          mode: 'auto',
          autoStatus: 'running',
          autoStopReason: null,
          autoRoundsCompleted: 2,
          autoMaxRounds: 5,
          autoCostSpentUsd: 0.1,
          autoCostLimitUsd: 1.5,
          autoColorContrastMode: 'disabled',
        },
      });
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
});
