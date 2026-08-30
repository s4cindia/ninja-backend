/**
 * PDF Auto-Remediation-Mode Controller
 *
 * Start/status/stop endpoints for a ComparisonTrial's "auto mode" run --
 * the backend-driven analyze->approve->apply->reaudit loop implemented in
 * auto-remediation-loop.service.ts. Trial-scoped: a job with no associated
 * ComparisonTrial cannot use auto mode.
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../utils/app-error';
import { autoRemediationLoopService } from '../services/pdf/auto-remediation-loop.service';

export class PdfAutoModeController {
  /**
   * POST /pdf/:jobId/auto-mode/start
   * Kicks off the auto-remediation loop for this job's trial (fire-and-forget,
   * returns 202). Poll GET /pdf/:jobId/auto-mode/status for progress.
   */
  async start(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      const trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (!trial) {
        throw AppError.badRequest('This job has no associated comparison trial -- auto mode is only available for trial jobs.');
      }
      if (trial.mode !== 'auto') {
        throw AppError.badRequest('Trial is not in auto mode. Set mode to "auto" before starting.');
      }
      if (trial.autoStatus === 'running') {
        throw AppError.conflict('Auto mode is already running for this trial.', 'AUTO_MODE_ALREADY_RUNNING');
      }

      // Fire-and-forget -- client polls the status endpoint below.
      void autoRemediationLoopService.startAutoLoop(trial.id);

      res.status(202).json({
        success: true,
        data: { status: 'running', message: 'Auto-remediation loop started. Poll GET /pdf/:jobId/auto-mode/status for progress.' },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/auto-mode/status
   */
  async getStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      const trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (!trial) {
        throw AppError.notFound('This job has no associated comparison trial.');
      }

      res.json({
        success: true,
        data: {
          mode: trial.mode,
          autoStatus: trial.autoStatus,
          autoStopReason: trial.autoStopReason,
          autoRoundsCompleted: trial.autoRoundsCompleted,
          autoMaxRounds: trial.autoMaxRounds,
          autoCostSpentUsd: trial.autoCostSpentUsd,
          autoCostLimitUsd: trial.autoCostLimitUsd,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /pdf/:jobId/auto-mode/stop
   * Cooperative stop: honored at the top of the loop's next round, never
   * mid-round, so a stop request never leaves the PDF half-applied.
   */
  async stop(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      const trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (!trial) {
        throw AppError.notFound('This job has no associated comparison trial.');
      }

      if (trial.autoStatus !== 'running') {
        res.json({ success: true, data: { message: 'Auto mode is not currently running.' } });
        return;
      }

      await prisma.comparisonTrial.update({
        where: { id: trial.id },
        data: { autoStopRequested: true },
      });

      res.json({ success: true, data: { message: 'Stop requested. The loop will stop after its current round finishes.' } });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAutoModeController = new PdfAutoModeController();
