/**
 * PDF Batch Controller
 *
 * CRUD + lifecycle endpoints for PdfBatch/PdfBatchItem -- the PDF-native
 * batch system (deliberately separate from the EPUB Batch/BatchFile
 * pipeline, see prisma/schema.prisma's own section comment). File bytes are
 * never handled here: items reference an already-uploaded, already-
 * confirmed `File` row (via POST /uploads/presign + POST /uploads/:fileId/confirm)
 * by id, matching PdfBatchItem.sourceFileId's loose-reference convention.
 */
import { Response } from 'express';
import { PdfBatch } from '@prisma/client';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { areQueuesAvailable, getPdfBatchItemQueue } from '../queues';
import { pdfBatchOrchestratorService } from '../services/pdf-batch/pdf-batch-orchestrator.service';
import { computeSizeWeight } from '../services/pdf-batch/concurrency-budget.service';
import { computeRemediationCounts } from '../services/pdf/remediation-cycle-history.service';
import { estimateBudgetForTenant } from '../services/pdf/auto-mode-budget-estimate.service';
import type { PdfBatchStartBody } from '../schemas/pdf-batch.schemas';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream']);

function isPdfFile(file: { mimeType: string; filename: string; originalName: string }): boolean {
  return PDF_MIME_TYPES.has(file.mimeType)
    || file.filename.toLowerCase().endsWith('.pdf')
    || file.originalName.toLowerCase().endsWith('.pdf');
}

class PdfBatchController {
  async createBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { name } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const batch = await prisma.pdfBatch.create({
        data: { tenantId, userId, name: name || this.generateBatchName() },
      });

      return res.status(201).json({
        success: true,
        data: { batchId: batch.id, name: batch.name, status: batch.status, totalFiles: batch.totalFiles, createdAt: batch.createdAt },
      });
    } catch (error) {
      logger.error('Create PDF batch failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to create batch', code: 'PDF_BATCH_CREATE_FAILED' },
      });
    }
  }

  async addItems(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;
      const { items } = req.body as { items: Array<{ sourceFileId: string }> };

      const batch = await prisma.pdfBatch.findFirst({ where: { id: batchId, tenantId } });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }
      if (batch.status !== 'DRAFT') {
        return res.status(400).json({ success: false, error: { message: 'Cannot add items to a batch that is not in DRAFT status', code: 'PDF_BATCH_NOT_DRAFT' } });
      }

      const createdItems = [];
      for (const { sourceFileId } of items) {
        // File rows are tenant-scoped only (no userId) -- matches
        // confirmUpload's own lookup convention. status: 'UPLOADED' means
        // the presign+confirm round trip actually completed; a file still
        // PENDING_UPLOAD was never verified to exist in S3 at all.
        const file = await prisma.file.findFirst({ where: { id: sourceFileId, tenantId, status: 'UPLOADED' } });
        if (!file) {
          return res.status(404).json({
            success: false,
            error: { message: `File not found or not yet confirmed: ${sourceFileId}`, code: 'SOURCE_FILE_NOT_FOUND' },
          });
        }
        if (!isPdfFile(file)) {
          return res.status(400).json({
            success: false,
            error: { message: `Only PDF files are supported: ${file.originalName}`, code: 'INVALID_FILE_TYPE' },
          });
        }

        const sizeWeightUnits = computeSizeWeight(BigInt(file.size));

        const item = await prisma.pdfBatchItem.create({
          data: {
            batchId: batch.id,
            fileName: file.filename,
            originalName: file.originalName,
            fileSize: BigInt(file.size),
            mimeType: file.mimeType,
            storagePath: file.storagePath ?? file.path,
            sourceFileId: file.id,
            sizeWeightUnits,
            status: 'UPLOADED',
          },
        });
        createdItems.push(item);
      }

      await prisma.pdfBatch.update({
        where: { id: batch.id },
        data: { totalFiles: { increment: createdItems.length } },
      });

      return res.status(201).json({
        success: true,
        data: {
          itemsAdded: createdItems.length,
          items: createdItems.map((i) => ({ itemId: i.id, fileName: i.fileName, originalName: i.originalName, fileSize: i.fileSize.toString(), status: i.status })),
        },
      });
    } catch (error) {
      logger.error('Add PDF batch items failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to add items', code: 'PDF_BATCH_ADD_ITEMS_FAILED' },
      });
    }
  }

  async removeItem(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, itemId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await prisma.pdfBatch.findFirst({ where: { id: batchId, tenantId } });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }
      if (batch.status !== 'DRAFT') {
        return res.status(400).json({ success: false, error: { message: 'Cannot remove items from a batch that is not in DRAFT status', code: 'PDF_BATCH_NOT_DRAFT' } });
      }

      const item = await prisma.pdfBatchItem.findFirst({ where: { id: itemId, batchId } });
      if (!item) {
        return res.status(404).json({ success: false, error: { message: 'Item not found', code: 'PDF_BATCH_ITEM_NOT_FOUND' } });
      }

      await prisma.pdfBatchItem.delete({ where: { id: itemId } });
      await prisma.pdfBatch.update({ where: { id: batchId }, data: { totalFiles: { decrement: 1 } } });

      return res.json({ success: true, data: null });
    } catch (error) {
      logger.error('Remove PDF batch item failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to remove item', code: 'PDF_BATCH_REMOVE_ITEM_FAILED' },
      });
    }
  }

  async startBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await prisma.pdfBatch.findFirst({ where: { id: batchId, tenantId }, include: { items: true } });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }
      if (batch.status !== 'DRAFT') {
        return res.status(400).json({ success: false, error: { message: 'Batch must be in DRAFT status to start', code: 'PDF_BATCH_NOT_DRAFT' } });
      }
      if (batch.totalFiles === 0 || batch.items.length === 0) {
        return res.status(400).json({ success: false, error: { message: 'Cannot start a batch with no files', code: 'PDF_BATCH_EMPTY' } });
      }

      const body = (req.body ?? {}) as NonNullable<PdfBatchStartBody>;
      const updated = await prisma.pdfBatch.update({
        where: { id: batchId },
        data: {
          status: 'QUEUED',
          startedAt: new Date(),
          ...(body.autoMaxRounds !== undefined && { autoMaxRounds: body.autoMaxRounds }),
          ...(body.autoCostLimitUsd !== undefined && { autoCostLimitUsd: body.autoCostLimitUsd }),
          ...(body.autoColorContrastMode !== undefined && { autoColorContrastMode: body.autoColorContrastMode }),
        },
      });

      for (const item of batch.items) {
        this.dispatchItem(batchId, item.id);
      }

      return res.json({
        success: true,
        data: { batchId: updated.id, status: updated.status, totalFiles: updated.totalFiles, startedAt: updated.startedAt },
      });
    } catch (error) {
      logger.error('Start PDF batch failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to start batch', code: 'PDF_BATCH_START_FAILED' },
      });
    }
  }

  /**
   * Routes a single item's processing through the PDF_BATCH_ITEM BullMQ
   * queue (worker process) when queues are available, falling back to the
   * original direct in-process call otherwise (local dev without Redis) --
   * same pattern as pdf-auto-mode.controller.ts's enqueueOrRunAutoLoop and
   * batch.controller.ts's dispatchBatchProcessing. Dispatch id includes
   * Date.now() (not the bare itemId) for the same wedged-queue reason those
   * two establish.
   */
  private dispatchItem(batchId: string, itemId: string): void {
    if (areQueuesAvailable()) {
      const queue = getPdfBatchItemQueue();
      if (queue) {
        queue.add(`pdf-batch-item-${itemId}`, { batchId, itemId }, { jobId: `${itemId}-${Date.now()}` }).catch((err) => {
          logger.error(`[PdfBatch] Failed to enqueue item ${itemId}, falling back to in-process: ${err instanceof Error ? err.message : String(err)}`);
          pdfBatchOrchestratorService.processItem(batchId, itemId).catch((err2) => {
            logger.error(`[PdfBatch] Unexpected error processing item ${itemId}: ${err2 instanceof Error ? err2.message : String(err2)}`);
          });
        });
        return;
      }
    }
    pdfBatchOrchestratorService.processItem(batchId, itemId).catch((err) => {
      logger.error(`[PdfBatch] Unexpected error processing item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async cancelBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await prisma.pdfBatch.findFirst({ where: { id: batchId, tenantId } });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }
      if (batch.status !== 'QUEUED' && batch.status !== 'PROCESSING') {
        return res.status(400).json({ success: false, error: { message: 'Can only cancel batches that are queued or processing', code: 'PDF_BATCH_NOT_CANCELLABLE' } });
      }

      await prisma.pdfBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', completedAt: new Date() } });

      // Items not yet picked up by a worker (still UPLOADED) can be marked
      // SKIPPED immediately for a snappier UI. Items already AUDITING/
      // REMEDIATING are NOT forced -- cooperative cancellation only: the
      // orchestrator checks the batch's status at phase boundaries and
      // aborts its lease wait if cancelled mid-wait (see
      // waitForLeaseCancellable), same "stop is cooperative" model as Auto
      // Mode. A worker that does pick up an already-cancelled item's queued
      // job will see CANCELLED on its very first check and mark it SKIPPED
      // itself -- this update is a UI nicety, not load-bearing for correctness.
      await prisma.pdfBatchItem.updateMany({
        where: { batchId, status: 'UPLOADED' },
        data: { status: 'SKIPPED' },
      });

      return res.json({ success: true, data: { batchId, status: 'CANCELLED' } });
    } catch (error) {
      logger.error('Cancel PDF batch failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to cancel batch', code: 'PDF_BATCH_CANCEL_FAILED' },
      });
    }
  }

  async getBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await prisma.pdfBatch.findFirst({
        where: { id: batchId, tenantId },
        include: { items: { orderBy: { uploadedAt: 'asc' } } },
      });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }

      const statusCounts = await this.computeStatusCounts(batchId);

      // Real gap (2026-10-21): pdf-batch-orchestrator.service.ts writes
      // issuesAutoFixed/issuesGuidanceOnly onto PdfBatchItem exactly ONCE,
      // right when its own runRemediationPhase call returns -- for ANY stop
      // reason, including budget_limit. That function's involvement with
      // the item is over at that point; there is no "paused, resumable"
      // state in the batch pipeline. A job can still genuinely keep
      // improving afterward via POST /pdf/:jobId/auto-mode/start (confirmed
      // live on Math_Olszewski_PDF.pdf: real further progress accrued past
      // a budget_limit stop), but nothing ever re-invokes
      // runRemediationPhase, so the stored snapshot here goes stale forever
      // while the underlying job keeps moving. Recomputing live from the
      // same source of truth (computeRemediationCounts, shared with that
      // orchestrator's own one-time write) keeps this endpoint honest --
      // same "derive at read time, don't trust a stored counter" pattern
      // computeStatusCounts above already uses deliberately.
      const liveCountsByItemId = new Map<string, { issuesAutoFixed: number; issuesGuidanceOnly: number }>();
      await Promise.all(
        batch.items
          .filter((i) => i.remediationStartedAt && i.auditJobId)
          .map(async (i) => {
            try {
              const counts = await computeRemediationCounts(i.auditJobId!, i.issuesFound);
              if (counts) liveCountsByItemId.set(i.id, counts);
            } catch (err) {
              // Non-fatal by design -- this is a live enhancement over an
              // already-correct stored snapshot (CodeRabbit finding,
              // confirmed real: Promise.all would otherwise fail the WHOLE
              // batch-detail request over one item's transient lookup
              // failure). Falls through to the stored i.issuesAutoFixed/
              // issuesGuidanceOnly below, same as when there's simply
              // nothing live to report yet.
              logger.warn(
                `[PdfBatchController] Live remediation-count lookup failed for item ${i.id} (job ${i.auditJobId}), falling back to stored snapshot: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          })
      );

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          name: batch.name,
          status: batch.status,
          totalFiles: batch.totalFiles,
          statusCounts,
          createdAt: batch.createdAt,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
          items: batch.items.map((i) => {
            const live = liveCountsByItemId.get(i.id);
            return {
              itemId: i.id,
              fileName: i.fileName,
              originalName: i.originalName,
              fileSize: i.fileSize.toString(),
              status: i.status,
              auditScore: i.auditScore,
              issuesFound: i.issuesFound,
              pageCount: i.pageCount,
              issuesAutoFixed: live?.issuesAutoFixed ?? i.issuesAutoFixed,
              issuesGuidanceOnly: live?.issuesGuidanceOnly ?? i.issuesGuidanceOnly,
              remediatedFilePath: i.remediatedFilePath,
              error: i.error,
              uploadedAt: i.uploadedAt,
              // Real bug (2026-10-18): PR #678 added these three fields to the
              // schema and had the orchestrator write them, but never actually
              // included them here -- so every consumer on the frontend has
              // been receiving undefined for all three: PdfBatchItemElapsed's
              // elapsed-time ticker has never rendered anything (its anchor
              // timestamps were always missing), and PdfBatchResultsList's
              // download button has never worked for a remediated item (it
              // needs auditJobId to build the download URL).
              auditJobId: i.auditJobId,
              auditStartedAt: i.auditStartedAt,
              auditCompletedAt: i.auditCompletedAt,
              remediationStartedAt: i.remediationStartedAt,
              remediationCompletedAt: i.remediationCompletedAt,
            };
          }),
        },
      });
    } catch (error) {
      logger.error('Get PDF batch failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to get batch', code: 'PDF_BATCH_GET_FAILED' },
      });
    }
  }

  /**
   * GET /pdf-batches/:batchId/budget-estimate
   * Suggested autoCostLimitUsd shown in the Start Processing config popover.
   * No item in a DRAFT batch has been audited yet, so this is necessarily a
   * tenant-wide estimate (see auto-mode-budget-estimate.service.ts's
   * estimateBudgetForTenant), not personalized to any specific item.
   */
  async getBudgetEstimate(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await prisma.pdfBatch.findFirst({ where: { id: batchId, tenantId }, select: { id: true } });
      if (!batch) {
        return res.status(404).json({ success: false, error: { message: 'Batch not found', code: 'PDF_BATCH_NOT_FOUND' } });
      }

      const estimate = await estimateBudgetForTenant(tenantId);
      return res.json({ success: true, data: estimate });
    } catch (error) {
      logger.error('Get PDF batch budget estimate failed', error);
      return res.status(500).json({
        // Fixed user-safe message -- error.message could be a raw Prisma/DB
        // error, which shouldn't reach the client. The real error is already
        // logged server-side above.
        success: false,
        error: { message: 'Failed to get budget estimate', code: 'PDF_BATCH_BUDGET_ESTIMATE_FAILED' },
      });
    }
  }

  async listBatches(req: AuthenticatedRequest, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, status } = req.query as unknown as { page: number; limit: number; status?: PdfBatch['status'] };

      const where = { tenantId, ...(status ? { status } : {}) };

      const [batches, total] = await Promise.all([
        prisma.pdfBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
        prisma.pdfBatch.count({ where }),
      ]);

      return res.json({
        success: true,
        data: {
          batches: batches.map((b) => ({ batchId: b.id, name: b.name, status: b.status, totalFiles: b.totalFiles, createdAt: b.createdAt })),
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
      });
    } catch (error) {
      logger.error('List PDF batches failed', error);
      return res.status(500).json({
        success: false,
        error: { message: error instanceof Error ? error.message : 'Failed to list batches', code: 'PDF_BATCH_LIST_FAILED' },
      });
    }
  }

  // Computed at read time from PdfBatchItem.status, never stored as
  // incremented counters -- deliberate, matches the schema's own comment
  // on PdfBatch.totalFiles explaining why (avoids the drift/reconciliation
  // bug the legacy Batch model's own counters have).
  private async computeStatusCounts(batchId: string): Promise<Record<string, number>> {
    const groups = await prisma.pdfBatchItem.groupBy({ by: ['status'], where: { batchId }, _count: { status: true } });
    return Object.fromEntries(groups.map((g) => [g.status, g._count.status]));
  }

  private generateBatchName(): string {
    const date = new Date().toISOString().split('T')[0];
    return `PDF Batch ${date}`;
  }
}

export const pdfBatchController = new PdfBatchController();
