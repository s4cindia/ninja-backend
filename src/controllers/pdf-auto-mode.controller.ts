/**
 * PDF Auto-Remediation-Mode Controller
 *
 * Start/status/stop endpoints for the backend-driven analyze->approve->
 * apply->reaudit loop implemented in auto-remediation-loop.service.ts.
 *
 * Two parallel paths, both reachable at the same three endpoints -- which
 * one applies is decided here, by whether the job has a linked
 * ComparisonTrial, not by anything the caller specifies:
 *   - Trial-linked job: EXACT original behavior, unchanged. Requires
 *     `trial.mode === 'auto'` (admin-configured ahead of time via
 *     PATCH /admin/comparison-study/trials/:id/auto-mode), ignores any
 *     request body, persists via ComparisonTrialAutoRemediationDriver.
 *   - Any other job the caller owns (authorizeJob already confirmed this):
 *     no trial required at all. An optional request body on `start` can
 *     override the round/cost/contrast ceiling for this run (validated by
 *     startAutoModeSchema); omitted fields fall back to
 *     PdfAutoRemediationRun's own schema defaults (10 rounds / $2.00 /
 *     apply-to-pdf). Persists via JobAutoRemediationDriver.
 *
 * This split exists because Auto Mode was originally built as part of the
 * Comparison Study research tooling and the trial requirement was never a
 * deliberate design choice for production use -- see JobAutoRemediationDriver
 * and the PdfAutoRemediationRun model (added for, but never wired into,
 * exactly this) for the production side.
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../utils/app-error';
import {
  autoRemediationLoopService,
  resolveColorContrastMode,
  ComparisonTrialAutoRemediationDriver,
  JobAutoRemediationDriver,
} from '../services/pdf/auto-remediation-loop.service';
import type { AutoRemediationDriver } from '../services/pdf/auto-remediation-loop.service';
import { areQueuesAvailable, getAutoRemediationQueue } from '../queues';
import type { StartAutoModeBody } from '../schemas/pdf-auto-mode.schemas';

/**
 * Routes a run through the auto-remediation BullMQ queue (worker process --
 * isolated from the ALB health checks that evicted the web task mid-round on
 * 2026-10-13, see auto-remediation.processor.ts) when queues are available,
 * falling back to the original direct in-process call otherwise -- keeps
 * local dev without Redis configured working exactly as before this change.
 *
 * Dispatch id is `${id}-${Date.now()}`, NOT the bare trial/run id. Real
 * incident, 2026-10-14: a worker-service deploy SIGKILLed the task mid-round,
 * which never let BullMQ observe a clean complete/fail for that job -- so
 * its entry under jobId `id` stayed stuck, and every subsequent start click
 * silently re-added/re-used that same wedged entry (202 response, but the
 * worker never logged picking it up again). The "free dedup against a
 * second concurrent start" a stable jobId was meant to buy is already fully
 * covered, correctly, by the autoStatus === 'running' check in both callers
 * below plus remediationCycleLockService's own atomic lock -- so there is no
 * actual loss from making the BullMQ id unique per attempt instead.
 */
function enqueueOrRunAutoLoop(kind: 'trial' | 'jobRun', id: string, driver: AutoRemediationDriver): void {
  if (areQueuesAvailable()) {
    const queue = getAutoRemediationQueue();
    if (queue) {
      queue.add(`auto-remediation-${id}`, { kind, id }, { jobId: `${id}-${Date.now()}` }).catch((err) => {
        logger.error(
          `[PdfAutoMode] Failed to enqueue auto loop for ${kind} ${id}, falling back to in-process: ${err instanceof Error ? err.message : String(err)}`
        );
        autoRemediationLoopService.startAutoLoop(driver).catch((err2) => {
          logger.error(
            `[PdfAutoMode] Unexpected error starting auto loop for ${kind} ${id}: ${err2 instanceof Error ? err2.message : String(err2)}`
          );
        });
      });
      return;
    }
  }
  autoRemediationLoopService.startAutoLoop(driver).catch((err) => {
    logger.error(
      `[PdfAutoMode] Unexpected error starting auto loop for ${kind} ${id}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

export class PdfAutoModeController {
  /**
   * POST /pdf/:jobId/auto-mode/start
   * Kicks off the auto-remediation loop for this job (fire-and-forget,
   * returns 202). Poll GET /pdf/:jobId/auto-mode/status for progress.
   */
  async start(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      let trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (trial) {
        if (trial.mode !== 'auto') {
          throw AppError.badRequest('Trial is not in auto mode. Set mode to "auto" before starting.');
        }
        if (trial.autoStatus === 'running') {
          // autoStatus can be stuck at 'running' from a crashed previous run
          // (e.g. an ECS deploy drained the task mid-round) -- reconcile
          // against the loop's own lock before treating this as a real
          // conflict, so a genuinely-dead run doesn't block a fresh start.
          await autoRemediationLoopService.reconcileIfOrphaned(trial.id);
          trial = await prisma.comparisonTrial.findUnique({ where: { id: trial.id } });
          if (trial?.autoStatus === 'running') {
            throw AppError.conflict('Auto mode is already running for this trial.', 'AUTO_MODE_ALREADY_RUNNING');
          }
        }
        if (!trial) {
          throw AppError.notFound('Trial not found.');
        }

        // Fire-and-forget -- client polls the status endpoint below. Runs on
        // the worker process via the auto-remediation queue when available
        // (see enqueueOrRunAutoLoop above).
        const trialId = trial.id;
        enqueueOrRunAutoLoop('trial', trialId, new ComparisonTrialAutoRemediationDriver(trialId));

        res.status(202).json({
          success: true,
          data: { status: 'running', message: 'Auto-remediation loop started. Poll GET /api/v1/pdf/:jobId/auto-mode/status for progress.' },
        });
        return;
      }

      // No trial -- the production, job-native path. The job is already
      // confirmed owned by the caller's tenant (authorizeJob), so there's
      // nothing else to gate on; an explicit POST to this endpoint IS the
      // opt-in.
      let run = await prisma.pdfAutoRemediationRun.findUnique({ where: { jobId } });
      if (run?.autoStatus === 'running') {
        await autoRemediationLoopService.reconcileIfOrphanedJobRun(run.id);
        run = await prisma.pdfAutoRemediationRun.findUnique({ where: { id: run.id } });
        if (run?.autoStatus === 'running') {
          throw AppError.conflict('Auto mode is already running for this job.', 'AUTO_MODE_ALREADY_RUNNING');
        }
      }

      const body = (req.body ?? {}) as NonNullable<StartAutoModeBody>;
      run = await prisma.pdfAutoRemediationRun.upsert({
        where: { jobId },
        create: {
          jobId,
          ...(body.autoMaxRounds !== undefined && { autoMaxRounds: body.autoMaxRounds }),
          ...(body.autoCostLimitUsd !== undefined && { autoCostLimitUsd: body.autoCostLimitUsd }),
          ...(body.autoColorContrastMode !== undefined && { autoColorContrastMode: body.autoColorContrastMode }),
        },
        update: {
          ...(body.autoMaxRounds !== undefined && { autoMaxRounds: body.autoMaxRounds }),
          ...(body.autoCostLimitUsd !== undefined && { autoCostLimitUsd: body.autoCostLimitUsd }),
          ...(body.autoColorContrastMode !== undefined && { autoColorContrastMode: body.autoColorContrastMode }),
        },
      });

      const runId = run.id;
      enqueueOrRunAutoLoop('jobRun', runId, new JobAutoRemediationDriver(runId));

      res.status(202).json({
        success: true,
        data: { status: 'running', message: 'Auto-remediation loop started. Poll GET /api/v1/pdf/:jobId/auto-mode/status for progress.' },
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

      let trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (trial) {
        if (trial.autoStatus === 'running') {
          await autoRemediationLoopService.reconcileIfOrphaned(trial.id);
          trial = (await prisma.comparisonTrial.findUnique({ where: { id: trial.id } })) ?? trial;
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
            // null means "inherits tenant/default config" -- normalized
            // through the same allowlist the loop itself uses, so a corrupted
            // stored value (only reachable via direct DB tampering) reports as
            // null rather than an unrecognized string.
            autoColorContrastMode: resolveColorContrastMode(trial.autoColorContrastMode) ?? null,
          },
        });
        return;
      }

      // No trial -- the production, job-native path. No row yet means auto
      // mode has never been started for this job; report the same shape
      // with "never run" defaults rather than 404ing, since (unlike the
      // trial path) this is the expected, common state for a job nobody has
      // opted into Auto Mode for yet.
      let run = await prisma.pdfAutoRemediationRun.findUnique({ where: { jobId } });
      if (!run) {
        res.json({
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
        return;
      }

      if (run.autoStatus === 'running') {
        await autoRemediationLoopService.reconcileIfOrphanedJobRun(run.id);
        run = (await prisma.pdfAutoRemediationRun.findUnique({ where: { id: run.id } })) ?? run;
      }

      res.json({
        success: true,
        data: {
          mode: 'auto',
          autoStatus: run.autoStatus,
          autoStopReason: run.autoStopReason,
          autoRoundsCompleted: run.autoRoundsCompleted,
          autoMaxRounds: run.autoMaxRounds,
          autoCostSpentUsd: run.autoCostSpentUsd,
          autoCostLimitUsd: run.autoCostLimitUsd,
          autoColorContrastMode: resolveColorContrastMode(run.autoColorContrastMode) ?? null,
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

      let trial = await prisma.comparisonTrial.findUnique({ where: { ninjaJobId: jobId } });
      if (trial) {
        if (trial.autoStatus === 'running') {
          await autoRemediationLoopService.reconcileIfOrphaned(trial.id);
          trial = (await prisma.comparisonTrial.findUnique({ where: { id: trial.id } })) ?? trial;
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
        return;
      }

      // No trial -- the production, job-native path.
      let run = await prisma.pdfAutoRemediationRun.findUnique({ where: { jobId } });
      if (!run) {
        res.json({ success: true, data: { message: 'Auto mode is not currently running.' } });
        return;
      }

      if (run.autoStatus === 'running') {
        await autoRemediationLoopService.reconcileIfOrphanedJobRun(run.id);
        run = (await prisma.pdfAutoRemediationRun.findUnique({ where: { id: run.id } })) ?? run;
      }

      if (run.autoStatus !== 'running') {
        res.json({ success: true, data: { message: 'Auto mode is not currently running.' } });
        return;
      }

      await prisma.pdfAutoRemediationRun.update({
        where: { id: run.id },
        data: { autoStopRequested: true },
      });

      res.json({ success: true, data: { message: 'Stop requested. The loop will stop after its current round finishes.' } });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAutoModeController = new PdfAutoModeController();
