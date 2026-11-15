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
import { AppError } from '../utils/app-error';
import {
  autoRemediationLoopService,
  resolveColorContrastMode,
  resolveAltTextMode,
  resolveLinkTextMode,
  resolveFullAutoMode,
  resolveEscalateOnStall,
  enqueueOrRunAutoLoop,
  ComparisonTrialAutoRemediationDriver,
  JobAutoRemediationDriver,
} from '../services/pdf/auto-remediation-loop.service';
import { getEffectiveAiRemediationConfig } from '../services/pdf/ai-remediation-tenant-config.service';
import { estimateBudgetForJob } from '../services/pdf/auto-mode-budget-estimate.service';
import type { StartAutoModeBody, UpdateJobSettingsBody } from '../schemas/pdf-auto-mode.schemas';

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
          ...(body.autoAltTextMode !== undefined && { autoAltTextMode: body.autoAltTextMode }),
          ...(body.autoLinkTextMode !== undefined && { autoLinkTextMode: body.autoLinkTextMode }),
        },
        update: {
          ...(body.autoMaxRounds !== undefined && { autoMaxRounds: body.autoMaxRounds }),
          ...(body.autoCostLimitUsd !== undefined && { autoCostLimitUsd: body.autoCostLimitUsd }),
          ...(body.autoColorContrastMode !== undefined && { autoColorContrastMode: body.autoColorContrastMode }),
          ...(body.autoAltTextMode !== undefined && { autoAltTextMode: body.autoAltTextMode }),
          ...(body.autoLinkTextMode !== undefined && { autoLinkTextMode: body.autoLinkTextMode }),
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
            autoStartedAt: trial.autoStartedAt,
            autoRoundsCompleted: trial.autoRoundsCompleted,
            autoMaxRounds: trial.autoMaxRounds,
            autoCostSpentUsd: trial.autoCostSpentUsd,
            autoCostLimitUsd: trial.autoCostLimitUsd,
            // null means "inherits tenant/default config" -- normalized
            // through the same allowlist the loop itself uses, so a corrupted
            // stored value (only reachable via direct DB tampering) reports as
            // null rather than an unrecognized string.
            autoColorContrastMode: resolveColorContrastMode(trial.autoColorContrastMode) ?? null,
            // ComparisonTrial has no autoAltTextMode column -- always
            // inherits the tenant/default altTextMode (see
            // ComparisonTrialAutoRemediationDriver.getRoundState).
            autoAltTextMode: null,
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

      // autoStatus is null both when no row exists yet and when one does
      // but the loop hasn't made its first write yet (schema: 'running' |
      // 'stopped' | null -- "never started"). Either way, Full Auto Mode
      // may still auto-start this job on its own once the initial audit +
      // AI analysis complete (accessibility.processor.ts) -- resolve it the
      // same way that trigger does and report it as `pendingFullAutoMode`,
      // so ninja-frontend's useAutoModeStatus (whose refetchInterval
      // otherwise stops polling for good the instant it sees ANY
      // non-'running' snapshot) knows to keep polling for a transition
      // nothing on the client ever requested. Real bug, caught live
      // (2026-11-14): a page left open since upload never saw a
      // Full-Auto-Mode run start OR finish, because its very first fetch --
      // taken right after upload, long before the trigger fires -- always
      // raced ahead of it and disabled the interval permanently.
      if (!run || run.autoStatus === null) {
        const aiRemediationConfig = await getEffectiveAiRemediationConfig(req.job!.tenantId);
        const pendingFullAutoMode = resolveFullAutoMode(req.job!.fullAutoMode, aiRemediationConfig.fullAutoModeDefault);

        res.json({
          success: true,
          data: {
            mode: run ? 'auto' : 'manual',
            autoStatus: null,
            autoStopReason: run?.autoStopReason ?? null,
            autoStartedAt: run?.autoStartedAt ?? null,
            autoRoundsCompleted: run?.autoRoundsCompleted ?? 0,
            autoMaxRounds: run?.autoMaxRounds ?? 10,
            autoCostSpentUsd: run?.autoCostSpentUsd ?? 0,
            autoCostLimitUsd: run?.autoCostLimitUsd ?? 2.0,
            autoColorContrastMode: run ? resolveColorContrastMode(run.autoColorContrastMode) ?? null : null,
            autoAltTextMode: run ? resolveAltTextMode(run.autoAltTextMode) ?? null : null,
            autoLinkTextMode: run ? resolveLinkTextMode(run.autoLinkTextMode) ?? null : null,
            autoStallEscalated: run?.autoStallEscalated ?? false,
            pendingFullAutoMode,
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
          autoStartedAt: run.autoStartedAt,
          autoRoundsCompleted: run.autoRoundsCompleted,
          autoMaxRounds: run.autoMaxRounds,
          autoCostSpentUsd: run.autoCostSpentUsd,
          autoCostLimitUsd: run.autoCostLimitUsd,
          autoColorContrastMode: resolveColorContrastMode(run.autoColorContrastMode) ?? null,
          autoAltTextMode: resolveAltTextMode(run.autoAltTextMode) ?? null,
          autoLinkTextMode: resolveLinkTextMode(run.autoLinkTextMode) ?? null,
          autoStallEscalated: run.autoStallEscalated,
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

  /**
   * GET /pdf/:jobId/auto-mode/budget-estimate
   * Suggested autoCostLimitUsd for this job, derived from real historical
   * spend on similarly-sized documents instead of the flat $2.00 default --
   * see auto-mode-budget-estimate.service.ts. Requires this job's own audit
   * to already be complete; returns the flat default (confidence: 'low')
   * rather than an error when it isn't.
   */
  async getBudgetEstimate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      const estimate = await estimateBudgetForJob(jobId);
      res.json({ success: true, data: estimate });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /pdf/:jobId/settings
   * Reports this job's own `fullAutoMode`/`autoEscalateOnStall` overrides
   * alongside the tenant default and the effective (resolved) value for
   * each -- previously fullAutoMode was set-and-forget at upload time with
   * no way to see or change it afterward; this and updateJobSettings below
   * give both per-job overrides a real, visible, editable-any-time home
   * (see the auto-escalate-on-stall design doc's "per-job override" section).
   * Changing either override after its own trigger moment has already
   * resolved for this job/run does nothing retroactively -- editable any
   * time, but only acts on what hasn't happened yet.
   */
  async getJobSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;

      const [job, aiRemediationConfig] = await Promise.all([
        prisma.job.findUnique({ where: { id: jobId }, select: { fullAutoMode: true, autoEscalateOnStall: true } }),
        getEffectiveAiRemediationConfig(req.job!.tenantId),
      ]);
      if (!job) throw AppError.notFound('Job not found.');

      res.json({
        success: true,
        data: {
          fullAutoMode: {
            override: job.fullAutoMode,
            tenantDefault: aiRemediationConfig.fullAutoModeDefault,
            effective: resolveFullAutoMode(job.fullAutoMode, aiRemediationConfig.fullAutoModeDefault),
          },
          autoEscalateOnStall: {
            override: job.autoEscalateOnStall,
            tenantDefault: aiRemediationConfig.autoEscalateOnStallDefault,
            effective: resolveEscalateOnStall(job.autoEscalateOnStall, aiRemediationConfig.autoEscalateOnStallDefault),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /pdf/:jobId/settings
   * Updates either or both overrides; omitted fields are left untouched. A
   * field set to `null` explicitly resets that override back to "inherit
   * the tenant default" (distinct from omitting it, which leaves whatever
   * value was already there).
   */
  async updateJobSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const jobId = req.job!.id;
      const body = (req.body ?? {}) as NonNullable<UpdateJobSettingsBody>;

      const [job, aiRemediationConfig] = await Promise.all([
        prisma.job.update({
          where: { id: jobId },
          data: {
            ...(body.fullAutoMode !== undefined && { fullAutoMode: body.fullAutoMode }),
            ...(body.autoEscalateOnStall !== undefined && { autoEscalateOnStall: body.autoEscalateOnStall }),
          },
          select: { fullAutoMode: true, autoEscalateOnStall: true },
        }),
        getEffectiveAiRemediationConfig(req.job!.tenantId),
      ]);

      res.json({
        success: true,
        data: {
          fullAutoMode: {
            override: job.fullAutoMode,
            tenantDefault: aiRemediationConfig.fullAutoModeDefault,
            effective: resolveFullAutoMode(job.fullAutoMode, aiRemediationConfig.fullAutoModeDefault),
          },
          autoEscalateOnStall: {
            override: job.autoEscalateOnStall,
            tenantDefault: aiRemediationConfig.autoEscalateOnStallDefault,
            effective: resolveEscalateOnStall(job.autoEscalateOnStall, aiRemediationConfig.autoEscalateOnStallDefault),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAutoModeController = new PdfAutoModeController();
