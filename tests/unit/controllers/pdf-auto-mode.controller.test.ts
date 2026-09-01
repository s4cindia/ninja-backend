/**
 * PdfAutoModeController -- start/status/stop endpoints for a ComparisonTrial's
 * auto-remediation loop. Trial-scoped: a job with no associated trial cannot
 * use auto mode.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
// resolveColorContrastMode is a pure function the controller uses to
// normalize the status response -- keep the real implementation via
// importOriginal so this test isn't duplicating its allowlist logic; only
// autoRemediationLoopService itself (the class with I/O side effects) needs
// mocking.
vi.mock('../../../src/services/pdf/auto-remediation-loop.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/pdf/auto-remediation-loop.service')>();
  return { ...actual, autoRemediationLoopService: { startAutoLoop: vi.fn() } };
});

import prisma from '../../../src/lib/prisma';
import { pdfAutoModeController } from '../../../src/controllers/pdf-auto-mode.controller';
import { autoRemediationLoopService } from '../../../src/services/pdf/auto-remediation-loop.service';

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
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

describe('PdfAutoModeController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('rejects with 400 when the job has no associated trial', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);

      await pdfAutoModeController.start(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(autoRemediationLoopService.startAutoLoop).not.toHaveBeenCalled();
    });

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

    it('kicks off the loop and responds 202 when eligible', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: null } as any);
      vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
      const res = makeRes();

      await pdfAutoModeController.start(makeReq(), res, next);

      expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith('trial-1');
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('getStatus', () => {
    it('returns 404 when the job has no associated trial', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);

      await pdfAutoModeController.getStatus(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

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

  describe('stop', () => {
    it('returns 404 when the job has no associated trial', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue(null as any);

      await pdfAutoModeController.stop(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('is a no-op (200, no update) when auto mode is not running', async () => {
      vi.mocked(prisma.comparisonTrial.findUnique).mockResolvedValue({ id: 'trial-1', autoStatus: 'stopped' } as any);
      const res = makeRes();

      await pdfAutoModeController.stop(makeReq(), res, next);

      expect(prisma.comparisonTrial.update).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
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
});
