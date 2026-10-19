/**
 * PDF Batch Orchestrator
 *
 * Drives a single PdfBatchItem through its full lifecycle -- audit, then a
 * full budgeted Auto Mode remediation run (see auto-remediation-loop.service.ts;
 * PdfAutoRemediationRun's field set is identical to Comparison Study's own
 * Auto Mode, a deliberate schema signal that a batch item's remediation
 * phase IS a full multi-round Auto Mode run, not a single bounded pass) --
 * each phase gated by a weighted lease from concurrency-budget.service.ts's
 * per-tenant budget.
 *
 * processItem(batchId, itemId) is the unit of work the PDF_BATCH_ITEM
 * BullMQ queue dispatches per item (see pdf-batch-item.processor.ts) --
 * this service has no awareness of BullMQ itself, matching
 * concurrency-budget.service.ts's own separation.
 *
 * Deliberately NOT built on batch-orchestrator.service.ts (the EPUB
 * Batch/BatchFile pipeline) -- see that model's own schema comment for why
 * (EPUB-shaped throughout, plain sequential for-loop, no real concurrency).
 */
import { nanoid } from 'nanoid';
import { Prisma, PdfBatch, PdfBatchItem } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { fileStorageService } from '../storage/file-storage.service';
import { pdfAuditService } from '../pdf/pdf-audit.service';
import { autoTagIfNeeded } from '../pdf/pdf-auto-tag-orchestrator.service';
import { createAuditProgressCallbacks } from '../pdf/pdf-audit-progress-tracker';
import { autoRemediationLoopService, JobAutoRemediationDriver } from '../pdf/auto-remediation-loop.service';
import { remediationCycleHistoryService } from '../pdf/remediation-cycle-history.service';
import {
  concurrencyBudgetService,
  computePageWeight,
  computeEffectiveWeight,
} from './concurrency-budget.service';
import type { ConcurrencyLeasePhase } from './concurrency-budget.service';

// Well under PdfConcurrencyLease's default 20-minute staleness threshold
// (pdfBatchConfig.leaseStaleMs) so a missed tick or two is never fatal.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// How often a phase waiting on a lease re-checks whether its batch was
// cancelled in the meantime, so waitForLease's AbortSignal actually gets
// used rather than only being checked at phase boundaries.
const CANCELLATION_POLL_MS = 10 * 1000;

// An item in any of these statuses is done -- processItem has already run
// it to completion once. Shared between the idempotent re-dispatch guard
// below and finalizeBatchIfComplete's own terminal check, so the two can
// never drift apart.
const TERMINAL_ITEM_STATUSES = ['REMEDIATED', 'FAILED', 'SKIPPED'] as const;

class PdfBatchOrchestratorService {
  async processItem(batchId: string, itemId: string): Promise<void> {
    const [batch, item] = await Promise.all([
      prisma.pdfBatch.findUnique({ where: { id: batchId } }),
      prisma.pdfBatchItem.findUnique({ where: { id: itemId } }),
    ]);

    if (!batch) {
      logger.warn(`[PdfBatchOrchestrator] Batch ${batchId} not found for item ${itemId} -- skipping`);
      return;
    }
    if (!item) {
      logger.warn(`[PdfBatchOrchestrator] Item ${itemId} not found (batch ${batchId}) -- skipping, likely deleted`);
      return;
    }

    // Idempotent guard against BullMQ re-dispatching this same item -- e.g.
    // its stalled-job recovery reprocessing a job whose original attempt
    // actually already finished (lockDuration exceeded without the
    // original attempt actually dying). Redoing a terminal item's full
    // audit/remediation lifecycle a second time would silently overwrite
    // its already-final result, not just waste work.
    if ((TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status)) {
      logger.warn(`[PdfBatchOrchestrator] Item ${itemId} is already ${item.status} -- ignoring re-dispatch`);
      return;
    }

    // First item to actually start processing flips the batch out of
    // QUEUED -- nothing else in the codebase ever makes this transition
    // (real incident: PdfBatch "Test Batch 02" stayed QUEUED forever even
    // after every item reached a terminal status, because
    // finalizeBatchIfComplete's CAS only matches status 'PROCESSING').
    // Idempotent CAS: a concurrent item making the same call after the
    // first one wins is a harmless no-op (count: 0).
    await prisma.pdfBatch.updateMany({
      where: { id: batchId, status: 'QUEUED' },
      data: { status: 'PROCESSING' },
    });

    try {
      if (await this.isCancelled(batchId)) {
        await this.markSkipped(itemId);
        return;
      }

      const auditJobId = await this.runAuditPhase(batch, item);

      if (await this.isCancelled(batchId)) {
        await this.markSkipped(itemId);
        return;
      }

      await this.runRemediationPhase(batch, itemId, auditJobId);
    } catch (err) {
      // A cancellation surfaces here as a thrown "aborted" error from
      // waitForLease (see waitForLeaseCancellable) -- re-check the batch's
      // own status rather than pattern-matching the error message, so this
      // is correct regardless of exactly how the abort manifested.
      if (await this.isCancelled(batchId).catch(() => false)) {
        await this.markSkipped(itemId);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[PdfBatchOrchestrator] Item ${itemId} failed: ${message}`);
        await prisma.pdfBatchItem.update({
          where: { id: itemId },
          data: {
            status: 'FAILED',
            error: message,
            errorDetails: (err instanceof Error ? { stack: err.stack } : {}) as Prisma.InputJsonValue,
            activeLeaseId: null,
          },
        }).catch((updateErr) => {
          logger.error(`[PdfBatchOrchestrator] Failed to mark item ${itemId} FAILED: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
        });
        await this.finalizeDanglingQueuedJob(itemId, 'FAILED', message);
      }
    } finally {
      await this.finalizeBatchIfComplete(batchId).catch((err) => {
        logger.error(`[PdfBatchOrchestrator] Failed to finalize batch ${batchId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private async isCancelled(batchId: string): Promise<boolean> {
    const batch = await prisma.pdfBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    return batch?.status === 'CANCELLED';
  }

  private async markSkipped(itemId: string): Promise<void> {
    await prisma.pdfBatchItem.update({
      where: { id: itemId },
      data: { status: 'SKIPPED', activeLeaseId: null },
    }).catch((err) => {
      logger.error(`[PdfBatchOrchestrator] Failed to mark item ${itemId} SKIPPED: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.finalizeDanglingQueuedJob(itemId, 'CANCELLED');
  }

  /** runAuditPhase now creates the item's Job row as 'QUEUED' (invisible to
   *  cleanupStalePdfJobs's watchdog, see that method's own doc comment) until
   *  its concurrency-budget lease actually comes through. If the item is
   *  cancelled or fails WHILE still queued -- before the lease is granted and
   *  the job ever flips to 'PROCESSING' -- nothing else in the codebase would
   *  otherwise ever resolve that Job row: the watchdog's query only matches
   *  'PROCESSING', so a 'QUEUED' job would sit there forever once its owning
   *  batch item has already reached a terminal status. Only touches a job
   *  still genuinely QUEUED -- one that already reached PROCESSING/COMPLETED
   *  has its own real outcome this must never overwrite. */
  private async finalizeDanglingQueuedJob(itemId: string, status: 'CANCELLED' | 'FAILED', error?: string): Promise<void> {
    const item = await prisma.pdfBatchItem.findUnique({ where: { id: itemId }, select: { auditJobId: true } }).catch(() => null);
    if (!item?.auditJobId) return;
    await prisma.job.updateMany({
      where: { id: item.auditJobId, status: 'QUEUED' },
      data: { status, completedAt: new Date(), ...(error ? { error } : {}) },
    }).catch((err) => {
      logger.error(`[PdfBatchOrchestrator] Failed to finalize dangling queued job for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** waitForLease wrapper that actually cancels the wait when the batch is
   *  cancelled mid-poll, instead of only checking cancellation at phase
   *  boundaries before/after a (potentially long) lease wait. */
  private async waitForLeaseCancellable(
    batchId: string,
    tenantId: string,
    itemId: string,
    phase: ConcurrencyLeasePhase,
    weightUnits: number
  ): Promise<string> {
    const controller = new AbortController();
    const watcher = setInterval(() => {
      this.isCancelled(batchId).then((cancelled) => {
        if (cancelled) controller.abort();
      }).catch(() => {});
    }, CANCELLATION_POLL_MS);

    try {
      return await concurrencyBudgetService.waitForLease(tenantId, itemId, phase, weightUnits, undefined, controller.signal);
    } finally {
      clearInterval(watcher);
    }
  }

  private startHeartbeat(leaseId: string): ReturnType<typeof setInterval> {
    return setInterval(() => {
      concurrencyBudgetService.heartbeatLease(leaseId).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Creates the item's Job row, runs the audit, and persists audit results
   *  + the page-based effective weight onto the item. Returns the Job id. */
  private async runAuditPhase(batch: PdfBatch, item: PdfBatchItem): Promise<string> {
    // Real incident (2026-10-19): this used to create the job already
    // status: 'PROCESSING' with a real startedAt, BEFORE the lease wait
    // below -- which can legitimately run 30-90+ minutes when a large item
    // is monopolizing the tenant's whole concurrency budget (by design, see
    // pdf-batch.config.ts). cleanupStalePdfJobs (src/workers/index.ts) kills
    // any 'PROCESSING' job whose updatedAt goes stale for 20+ minutes, with
    // no awareness that a batch item can legitimately sit queued that long
    // before real work even starts -- so FMHE_PDF.pdf's audit was killed as
    // "orphaned" after 20 minutes of pure queueing, never having done a
    // single second of real work. JobStatus.QUEUED (the schema's own
    // default, startedAt left null) is invisible to that watchdog's query
    // (status: 'PROCESSING' only) -- the same distinction the batch item's
    // own QUEUED_FOR_BUDGET vs AUDITING status already makes below, just not
    // mirrored onto the Job row until now.
    const job = await prisma.job.create({
      data: {
        id: nanoid(),
        tenantId: batch.tenantId,
        userId: batch.userId,
        type: 'PDF_ACCESSIBILITY',
        status: 'QUEUED',
        input: {
          fileName: item.originalName,
          batchId: batch.id,
          batchItemId: item.id,
          size: Number(item.fileSize),
        } as unknown as Prisma.InputJsonObject,
      },
    });

    // QUEUED_FOR_BUDGET until the lease actually comes through -- waiting
    // on a full tenant budget can take a while, and showing AUDITING before
    // any real work has started would misrepresent what's actually
    // happening (both to a UI poller and to anyone reading the row directly).
    try {
      await prisma.pdfBatchItem.update({
        where: { id: item.id },
        data: { status: 'QUEUED_FOR_BUDGET', auditJobId: job.id, auditStartedAt: new Date() },
      });
    } catch (linkErr) {
      // CodeRabbit finding on this PR, confirmed real: if this specific write
      // fails, the item's auditJobId link never lands, so finalizeDanglingQueuedJob
      // (processItem's catch block, below) has no way to find this job by
      // looking at the item -- it would stay QUEUED forever otherwise. job.id
      // is still known locally here, so finalize it directly instead of
      // relying on that downstream lookup succeeding.
      await prisma.job.updateMany({
        where: { id: job.id, status: 'QUEUED' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error: linkErr instanceof Error ? linkErr.message : String(linkErr),
        },
      }).catch((err) => {
        logger.error(`[PdfBatchOrchestrator] Failed to finalize orphaned job ${job.id} after link failure: ${err instanceof Error ? err.message : String(err)}`);
      });
      throw linkErr;
    }

    const leaseId = await this.waitForLeaseCancellable(batch.id, batch.tenantId, item.id, 'audit', item.sizeWeightUnits);
    const heartbeat = this.startHeartbeat(leaseId);

    try {
      // CodeRabbit finding on this PR, confirmed real: both of these used to
      // run BEFORE this try (whose finally releases the lease acquired just
      // above) -- a failure in either would leak the lease forever, since
      // nothing downstream of runAuditPhase ever releases a lease it never
      // acquired a reference to.
      await prisma.pdfBatchItem.update({ where: { id: item.id }, data: { status: 'AUDITING', activeLeaseId: leaseId } });
      // Only now does real work start -- flip the Job row to 'PROCESSING'
      // with its real startedAt, so the stale-job watchdog's 20-minute clock
      // starts from here, not from whenever this item was first admitted to
      // the batch queue.
      await prisma.job.update({ where: { id: job.id }, data: { status: 'PROCESSING', startedAt: new Date() } });

      const buffer = await fileStorageService.downloadFile(item.storagePath);

      // Real incident (2026-10-18): every single batch item's remediation
      // phase failed on its very first round with "PDF file not found in
      // storage for job <id>" -- ai-analysis.service.ts's analyzeJob()
      // loads the PDF via fileStorageService.getFile(jobId, fileName) (the
      // job-storage/<jobId>/<fileName> convention pdf.controller.ts's
      // single-file upload flow establishes by calling saveFile before
      // dispatching its own audit job), but this orchestrator ran the
      // audit straight from item.storagePath (the batch item's own upload
      // location) without ever persisting the buffer under that job-centric
      // key. This masked every batch remediation as a silent no-op (0
      // rounds, 0 issues fixed) until PR #689 made that failure visible
      // instead of mis-marking the item REMEDIATED regardless.
      await fileStorageService.saveFile(job.id, item.originalName, buffer);

      // Real incident (2026-10-18): this orchestrator never auto-tagged an
      // untagged PDF before auditing it -- it called pdfAuditService
      // .runAuditFromBuffer directly, bypassing accessibility.processor.ts
      // entirely, which is the ONLY place the Seam C / Adobe AutoTag
      // decision (shared via pdf-auto-tag-orchestrator.service.ts, 2026-10-18
      // extraction) ever lived. Every batch item skipped tagging regardless
      // of whether it needed it -- the same class of gap PR #452 fixed for
      // direct UI uploads, now closed here too. No forceAutoTag equivalent
      // for batch items yet (out of scope -- see the plan's Comparison
      // Study-only framing for that flag).
      const { auditBuffer, autoTagMeta } = await autoTagIfNeeded(buffer, job.id, item.originalName, false);

      // Real gap (2026-10-18): this call never passed progress callbacks,
      // unlike accessibility.processor.ts's equivalent call -- so a batch
      // item's Job.input never got totalPages/validatorProgress written,
      // leaving GET /jobs/:auditJobId (and the PdfJobProgressPanel UI that
      // polls it) with nothing to show during a batch item's audit phase.
      // createAuditProgressCallbacks uses the single-file worker's own
      // default percentage scheme (20-88% extraction, 88-95% validators),
      // which is what that UI component's page-number math is hard-coded
      // to -- using the same defaults here means it works against a batch
      // item's job with zero frontend changes.
      const { onProgress, onValidatorComplete, onAltTextImageProgress, onContrastPageProgress } = createAuditProgressCallbacks({ jobId: job.id });

      const report = await pdfAuditService.runAuditFromBuffer(
        auditBuffer,
        job.id,
        item.originalName,
        'comprehensive',
        undefined,
        onProgress,
        onValidatorComplete,
        onAltTextImageProgress,
        onContrastPageProgress
      );

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: {
            fileName: item.originalName,
            auditReport: report as unknown as Record<string, unknown>,
            scanLevel: 'comprehensive',
            type: 'PDF_ACCESSIBILITY',
            dbJobId: job.id,
            ...autoTagMeta,
          } as unknown as Prisma.InputJsonObject,
        },
      });

      const pageCount = (report.metadata as { pageCount?: number } | undefined)?.pageCount ?? 1;
      const pageWeightUnits = computePageWeight(pageCount);
      const effectiveWeightUnits = computeEffectiveWeight(item.sizeWeightUnits, pageWeightUnits);

      await prisma.pdfBatchItem.update({
        where: { id: item.id },
        data: {
          status: 'AUDITED',
          auditScore: report.score,
          issuesFound: report.issues.length,
          pageCount,
          effectiveWeightUnits,
          auditCompletedAt: new Date(),
        },
      });

      return job.id;
    } finally {
      clearInterval(heartbeat);
      await concurrencyBudgetService.releaseLease(leaseId);
      await prisma.pdfBatchItem.update({ where: { id: item.id }, data: { activeLeaseId: null } }).catch(() => {});
    }
  }

  /** Runs the item's remediation phase as a full Auto Mode loop against its
   *  already-audited Job, using PdfAutoRemediationRun's own schema defaults
   *  (10 rounds / $2.00) -- no per-batch override in this pass. Persists
   *  the loop's real outcome (read back from job.output and the
   *  remediation-cycle history, not guessed) onto the item. */
  private async runRemediationPhase(batch: PdfBatch, itemId: string, jobId: string): Promise<void> {
    const item = await prisma.pdfBatchItem.findUniqueOrThrow({ where: { id: itemId } });
    const effectiveWeightUnits = item.effectiveWeightUnits ?? item.sizeWeightUnits;

    // HELD_FOR_BUDGET until the lease comes through -- same reasoning as
    // QUEUED_FOR_BUDGET in runAuditPhase.
    await prisma.pdfBatchItem.update({
      where: { id: itemId },
      data: { status: 'HELD_FOR_BUDGET', remediationStartedAt: new Date() },
    });

    const leaseId = await this.waitForLeaseCancellable(batch.id, batch.tenantId, itemId, 'auto_remediation', effectiveWeightUnits);
    await prisma.pdfBatchItem.update({ where: { id: itemId }, data: { status: 'REMEDIATING', activeLeaseId: leaseId } });
    const heartbeat = this.startHeartbeat(leaseId);

    try {
      // Row's existence is the opt-in signal startAutoLoop checks for (see
      // JobAutoRemediationDriver's own doc comment). Carries the batch's own
      // Auto Mode overrides (set once at POST .../start, see
      // pdf-batch.controller.ts's startBatch) onto this item's own run --
      // each item still gets its own independent budget/round count, not a
      // shared pool across the batch. Omitted/null batch fields fall back
      // to PdfAutoRemediationRun's own schema defaults, same conditional-
      // spread convention pdf-auto-mode.controller.ts's upsert uses.
      const run = await prisma.pdfAutoRemediationRun.upsert({
        where: { jobId },
        create: {
          jobId,
          ...(batch.autoMaxRounds != null && { autoMaxRounds: batch.autoMaxRounds }),
          ...(batch.autoCostLimitUsd != null && { autoCostLimitUsd: batch.autoCostLimitUsd }),
          ...(batch.autoColorContrastMode != null && { autoColorContrastMode: batch.autoColorContrastMode }),
        },
        update: {
          ...(batch.autoMaxRounds != null && { autoMaxRounds: batch.autoMaxRounds }),
          ...(batch.autoCostLimitUsd != null && { autoCostLimitUsd: batch.autoCostLimitUsd }),
          ...(batch.autoColorContrastMode != null && { autoColorContrastMode: batch.autoColorContrastMode }),
        },
      });

      // Never throws -- always resolves having written a terminal
      // autoStatus, per PR #666/#669's guarantees.
      await autoRemediationLoopService.startAutoLoop(new JobAutoRemediationDriver(run.id));

      // Real incident (2026-10-17): startAutoLoop can stop immediately with
      // zero rounds completed, zero cost, and (until the companion fix in
      // auto-remediation-loop.service.ts) zero logging anywhere --
      // getRoundState() returned null moments after the same record was
      // found via getConfig() just before it; root cause still unconfirmed
      // (confirmed NOT a lock-contention race -- that path logs its own
      // warning and we saw none). Before this check, that silently fell
      // through to the REMEDIATED write below regardless of outcome,
      // surfacing a misleading "Remediated" badge in the UI with 0 issues
      // fixed and no download link, no retry affordance -- exactly what the
      // audit phase's own FAILED path already handles correctly. Throwing
      // here reuses that same existing, correct error-handling path
      // (processItem's catch, below) instead of duplicating it.
      const finalRun = await prisma.pdfAutoRemediationRun.findUnique({ where: { id: run.id } });
      if (finalRun?.autoStopReason === 'error' && finalRun.autoRoundsCompleted === 0) {
        throw new Error(
          'Remediation failed to start: auto-mode stopped immediately with no rounds completed (see the remediation history for this job)'
        );
      }

      const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
      const output = (finalJob?.output ?? {}) as Record<string, unknown>;
      const remediatedFilePath = (output.remediatedFileUrl as string | undefined) ?? null;

      // The loop's own per-round reaudit already logs resolved/remaining
      // counts to the same append-only history GET .../remediation/history
      // reads -- take the latest completed one rather than re-deriving
      // counts some other way.
      const events = await remediationCycleHistoryService.listForJob(jobId);
      const lastReaudit = [...events].reverse().find(
        (e) => e.action === 'reaudit' && e.status === 'completed' && e.resolvedCount != null
      );
      const issuesAutoFixed = lastReaudit?.resolvedCount ?? 0;
      const issuesGuidanceOnly = lastReaudit?.remainingCount ?? 0;

      await prisma.pdfBatchItem.update({
        where: { id: itemId },
        data: {
          status: 'REMEDIATED',
          issuesAutoFixed,
          issuesGuidanceOnly,
          remediatedFilePath,
          remediationCompletedAt: new Date(),
        },
      });
    } finally {
      clearInterval(heartbeat);
      await concurrencyBudgetService.releaseLease(leaseId);
      await prisma.pdfBatchItem.update({ where: { id: itemId }, data: { activeLeaseId: null } }).catch(() => {});
    }
  }

  /**
   * Watchdog: finds items stuck in AUDITING/REMEDIATING whose underlying
   * lease is already gone (released, or missing outright) -- meaning
   * whatever process was holding it died before reaching its own `finally`
   * (processItem's own cleanup, or runAuditPhase/runRemediationPhase's),
   * which would otherwise have transitioned the item's status itself.
   * concurrency-budget.service.ts's reconcileStaleLeases frees the
   * underlying LEASE (so the tenant's budget self-heals) but has -- by
   * design -- zero awareness of PdfBatchItem as a domain object, so it can
   * never correct the item's own status; this is that missing other half,
   * mirroring auto-remediation-loop.service.ts's reconcileAllOrphanedRuns
   * for job-native Auto Mode.
   *
   * Real incident this closes: a batch item hung inside the audit's PDF
   * parser (no timeout existed anywhere -- see pdf-audit.service.ts's
   * withAuditTimeout) and sat in AUDITING for ~24h, surviving two full
   * worker redeploys, because nothing ever revisited its status once the
   * process handling it was gone.
   *
   * MUST run after concurrencyBudgetService.reconcileStaleLeases() in the
   * same watchdog tick (see workers/index.ts) -- that call is what
   * actually releases a genuinely-stale lease; by the time this runs, "no
   * active lease" reliably means "definitely orphaned," not "maybe just
   * hasn't gone stale yet," so there is no need to duplicate its own
   * heartbeat-staleness check here.
   *
   * Deliberately does NOT cover QUEUED_FOR_BUDGET/HELD_FOR_BUDGET -- those
   * states hold no lease yet (nothing to check for staleness), and a
   * time-based cutoff instead would risk failing an item that's genuinely,
   * legitimately still waiting on a saturated tenant budget. No reliable
   * orphan signal exists for that case yet.
   */
  async reconcileOrphanedItems(): Promise<number> {
    const candidates = await prisma.pdfBatchItem.findMany({
      where: { status: { in: ['AUDITING', 'REMEDIATING'] } },
    });

    let reconciledCount = 0;
    for (const item of candidates) {
      const lease = item.activeLeaseId
        ? await prisma.pdfConcurrencyLease.findUnique({ where: { id: item.activeLeaseId } })
        : null;
      const isOrphaned = !lease || lease.releasedAt !== null;
      if (!isOrphaned) continue;

      // CAS on the status actually observed above -- if the real
      // orchestrator is (rarely) mid-transition right now, this leaves it
      // alone rather than racing it, instead of blindly overwriting
      // whatever its status is by the time this UPDATE runs.
      const { count } = await prisma.pdfBatchItem.updateMany({
        where: { id: item.id, status: item.status },
        data: {
          status: 'FAILED',
          error: `Processing stopped unexpectedly while ${item.status === 'AUDITING' ? 'auditing' : 'remediating'} -- the worker handling this item crashed, hung, or was restarted mid-task. No automatic retry exists; re-add this file to a new batch to retry it.`,
          activeLeaseId: null,
        },
      });
      if (count === 0) continue;

      reconciledCount++;
      logger.warn(
        `[PdfBatchOrchestrator] Reconciled orphaned item ${item.id} (batch ${item.batchId}, was ${item.status}) -- its lease was already gone/released with no status transition to match`
      );
      await this.finalizeBatchIfComplete(item.batchId).catch((err) => {
        logger.error(`[PdfBatchOrchestrator] Failed to finalize batch ${item.batchId} after reconciling orphaned item ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return reconciledCount;
  }

  /** Race-safe: every item's processItem call reaches this on completion,
   *  so many can observe "all items terminal" at once. Only the call that
   *  actually flips PROCESSING -> COMPLETED via the conditional updateMany
   *  does the finalization -- same atomic-CAS philosophy as
   *  concurrency-budget.service.ts / remediation-cycle-lock.service.ts. */
  private async finalizeBatchIfComplete(batchId: string): Promise<void> {
    const [totalCount, terminalCount] = await Promise.all([
      prisma.pdfBatchItem.count({ where: { batchId } }),
      prisma.pdfBatchItem.count({ where: { batchId, status: { in: [...TERMINAL_ITEM_STATUSES] } } }),
    ]);

    if (totalCount === 0 || terminalCount < totalCount) return;

    // COMPLETED here means "the batch finished running," same as the EPUB
    // Batch pipeline's own convention -- per-item FAILED status is already
    // visible via GET /:batchId's computed counts; it doesn't flip the
    // whole batch to an overall FAILED state.
    await prisma.pdfBatch.updateMany({
      where: { id: batchId, status: 'PROCESSING' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }
}

export const pdfBatchOrchestratorService = new PdfBatchOrchestratorService();
