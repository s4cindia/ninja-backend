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
    const job = await prisma.job.create({
      data: {
        id: nanoid(),
        tenantId: batch.tenantId,
        userId: batch.userId,
        type: 'PDF_ACCESSIBILITY',
        status: 'PROCESSING',
        input: {
          fileName: item.originalName,
          batchId: batch.id,
          batchItemId: item.id,
          size: Number(item.fileSize),
        } as unknown as Prisma.InputJsonObject,
        startedAt: new Date(),
      },
    });

    await prisma.pdfBatchItem.update({
      where: { id: item.id },
      data: { status: 'AUDITING', auditJobId: job.id, auditStartedAt: new Date() },
    });

    const leaseId = await this.waitForLeaseCancellable(batch.id, batch.tenantId, item.id, 'audit', item.sizeWeightUnits);
    await prisma.pdfBatchItem.update({ where: { id: item.id }, data: { activeLeaseId: leaseId } });
    const heartbeat = this.startHeartbeat(leaseId);

    try {
      const buffer = await fileStorageService.downloadFile(item.storagePath);
      const report = await pdfAuditService.runAuditFromBuffer(buffer, job.id, item.originalName, 'comprehensive');

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

    await prisma.pdfBatchItem.update({
      where: { id: itemId },
      data: { status: 'REMEDIATING', remediationStartedAt: new Date() },
    });

    const leaseId = await this.waitForLeaseCancellable(batch.id, batch.tenantId, itemId, 'auto_remediation', effectiveWeightUnits);
    await prisma.pdfBatchItem.update({ where: { id: itemId }, data: { activeLeaseId: leaseId } });
    const heartbeat = this.startHeartbeat(leaseId);

    try {
      // Row's existence is the opt-in signal startAutoLoop checks for (see
      // JobAutoRemediationDriver's own doc comment) -- mirrors
      // pdf-auto-mode.controller.ts's upsert exactly, no config overrides.
      const run = await prisma.pdfAutoRemediationRun.upsert({
        where: { jobId },
        create: { jobId },
        update: {},
      });

      // Never throws -- always resolves having written a terminal
      // autoStatus, per PR #666/#669's guarantees.
      await autoRemediationLoopService.startAutoLoop(new JobAutoRemediationDriver(run.id));

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

  /** Race-safe: every item's processItem call reaches this on completion,
   *  so many can observe "all items terminal" at once. Only the call that
   *  actually flips PROCESSING -> COMPLETED via the conditional updateMany
   *  does the finalization -- same atomic-CAS philosophy as
   *  concurrency-budget.service.ts / remediation-cycle-lock.service.ts. */
  private async finalizeBatchIfComplete(batchId: string): Promise<void> {
    const TERMINAL = ['REMEDIATED', 'FAILED', 'SKIPPED'] as const;
    const [totalCount, terminalCount] = await Promise.all([
      prisma.pdfBatchItem.count({ where: { batchId } }),
      prisma.pdfBatchItem.count({ where: { batchId, status: { in: [...TERMINAL] } } }),
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
