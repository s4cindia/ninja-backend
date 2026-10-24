/**
 * PDF Auto-Tag Orchestrator
 *
 * Decides whether a PDF needs auto-tagging (Seam C, with Adobe AutoTag as
 * fallback) before an accessibility audit runs, and drives that tagging
 * pass. Extracted from accessibility.processor.ts (2026-10-18) so the PDF
 * Batch pipeline (pdf-batch-orchestrator.service.ts) can share the exact
 * same logic instead of silently skipping auto-tagging entirely -- which it
 * did until this extraction, the same class of gap PR #452 fixed for direct
 * UI uploads.
 */
import { Prisma } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { adobeAutoTagService } from './adobe-autotag.service';
import { seamCTagService } from './seam-c-tag.service';
import { pdfParserService } from './pdf-parser.service';
import { checkStructureTreeCompleteness } from './structure-tree-completeness';
import { prepareDocumentForRetag } from './strip-marked-content';
import { fileStorageService } from '../storage/file-storage.service';
import { aiConfig } from '../../config/ai.config';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// Real incident (2026-10-24, FMHE_PDF.pdf / forceAutoTag): Seam C's own
// detector call can legitimately take ~20 minutes on a large (2040-page)
// document, during which nothing touches the Job row at all -- the
// watchdog's PDF_JOB_STALE_TIMEOUT_MS (20 min default, src/workers/index.ts)
// has no way to distinguish "the worker died" from "the worker is alive and
// waiting on a slow-but-working external call," so it killed a job seconds
// before the tagging call it was waiting on actually succeeded. Any
// Job.update() bumps updatedAt (Prisma's @updatedAt), so a periodic no-op
// touch during the tagging call is enough to keep the watchdog's clock from
// expiring out from under genuinely in-progress (if slow) work. Interval is
// well under the 20-minute threshold to tolerate a missed tick or two.
const AUTOTAG_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;

async function runWithJobHeartbeat<T>(dbJobId: string, fn: () => Promise<T>): Promise<T> {
  const interval = setInterval(() => {
    prisma.job.update({ where: { id: dbJobId }, data: { updatedAt: new Date() } }).catch((err) => {
      logger.warn(`[PdfAutoTagOrchestrator] Heartbeat update failed for job ${dbJobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }, AUTOTAG_HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

export interface AutoTagOutcome {
  /** Possibly-tagged PDF bytes to audit -- fileBuffer unchanged if tagging was skipped or failed. */
  auditBuffer: Buffer;
  /** Whether the PDF was already tagged BEFORE this function ran (pre-check only). */
  isTagged: boolean;
  /** Merged into job.output by the caller -- autoTagStatus/taggerSource/etc. */
  autoTagMeta: Record<string, unknown>;
}

/**
 * Runs when the caller is about to trust an existing structure tree instead
 * of tagging (either the isTagged pre-check skipped tagging outright, or
 * Seam C's own SEAM_C_ALREADY_TAGGED backstop refused to run). Both of
 * those gates only check that /StructTreeRoot exists -- this measures
 * whether it's actually worth trusting. Read-only; never affects control
 * flow, only what gets logged and recorded on the job. Failures here are
 * non-fatal -- a completeness check that itself breaks shouldn't block the
 * pipeline it's just observing.
 */
async function logStructureCompleteness(buffer: Buffer, dbJobId: string): Promise<Record<string, unknown>> {
  try {
    const doc = await PDFDocument.load(buffer);
    const completeness = checkStructureTreeCompleteness(doc);
    if (!completeness) return {};
    if (completeness.isEmptyShell) {
      logger.warn(
        `[PdfAutoTagOrchestrator] Existing structure tree for job ${dbJobId} is an empty shell — ` +
        `${completeness.totalElements} element(s), 0 semantically tagged (no Figure/P/H/Table/etc). ` +
        `Writers that need a real content-typed element (e.g. alt-text) will find nothing to attach to.`
      );
    } else if (completeness.isHeadingShell) {
      logger.warn(
        `[PdfAutoTagOrchestrator] Existing structure tree for job ${dbJobId} has ${completeness.semanticElements} ` +
        `semantic element(s) but 0 heading tags (H1-H9) — fixHeadingHierarchy will find nothing to ` +
        `rename regardless of how many heading-skip issues detection reports.`
      );
    }
    return { structureTreeCompleteness: completeness };
  } catch (err) {
    logger.warn(`[PdfAutoTagOrchestrator] Structure tree completeness check failed for job ${dbJobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * Tags a PDF with Seam C (default) or Adobe AutoTag (fallback) if it needs
 * it, before an accessibility audit runs. Never throws -- a tagging failure
 * degrades to auditing the original, untagged buffer rather than failing
 * the whole job, matching the single-file upload flow's own established
 * behavior.
 *
 * @param fileBuffer - Original PDF bytes, as downloaded/read from storage
 * @param dbJobId - The Job row this tagging pass is recorded against (progress bookkeeping lives in job.input)
 * @param fileName - Original file name, used for the remediated/report/docx storage keys
 * @param forceAutoTag - Forces a re-tag even when the existing structure is genuinely
 *   good (not just empty/heading-shell -- see below). Scoped to Comparison Study trials:
 *   the /MarkInfo /Marked flag isTagged relies on only means a PDF *claims* structure,
 *   and a real document can have perfectly good tagging already -- forcing a re-tag over
 *   that on a regular upload would clobber genuinely good structure for no reason, but a
 *   trial's whole purpose is measuring what Ninja's own pipeline produces regardless.
 */
export async function autoTagIfNeeded(
  fileBuffer: Buffer,
  dbJobId: string,
  fileName: string,
  forceAutoTag = false
): Promise<AutoTagOutcome> {
  // Quick tagged check — lightweight parse to detect PDF structure tree presence
  let isTagged = false;
  try {
    const parsedMeta = await pdfParserService.parseBuffer(fileBuffer, fileName);
    isTagged = parsedMeta.structure.metadata.isTagged ?? false;
    await pdfParserService.close(parsedMeta).catch(() => {});
  } catch (tagCheckErr) {
    logger.warn(`[PdfAutoTagOrchestrator] Tagged check failed (assuming untagged): ${tagCheckErr instanceof Error ? tagCheckErr.message : String(tagCheckErr)}`);
  }

  logger.info(`[PdfAutoTagOrchestrator] PDF isTagged=${isTagged} for job ${dbJobId}`);

  // Real incident (Math_Olszewski_PDF.pdf, 2026-10-21): isTagged above is a
  // pure /MarkInfo /Marked presence check -- a document can set that flag
  // while its structure tree is a complete empty shell (415 elements, 0
  // semantically typed) or has real content tags but zero headings. Before
  // this, that was only ever detected AFTER deciding to skip tagging (purely
  // for logging), and the actual strip-and-retag fix for it only ran for
  // forceAutoTag (Comparison Study trials) -- a regular upload or PDF Batch
  // item with a claimed-but-useless structure tree never got real tagging on
  // any production path, no matter how badly it needed it. Checking upfront
  // (when claimed-tagged) lets an empty/heading-shell document get the same
  // real tagging pass forceAutoTag already proved safe for trials.
  let upfrontCompleteness: ReturnType<typeof checkStructureTreeCompleteness> = null;
  if (isTagged) {
    try {
      const doc = await PDFDocument.load(fileBuffer);
      upfrontCompleteness = checkStructureTreeCompleteness(doc);
    } catch (completenessErr) {
      logger.warn(`[PdfAutoTagOrchestrator] Upfront completeness check failed for job ${dbJobId} (treating existing structure as trustworthy): ${completenessErr instanceof Error ? completenessErr.message : String(completenessErr)}`);
    }
  }
  const needsRetagUpfront = upfrontCompleteness?.isEmptyShell || upfrontCompleteness?.isHeadingShell || false;

  let auditBuffer = fileBuffer;
  let autoTagMeta: Record<string, unknown> = {};
  // Seam C is the DEFAULT tagger; Adobe is the fallback. Tag any untagged
  // (or claimed-tagged-but-shell) PDF when at least one tagger is available.
  const shouldAutoTag = (forceAutoTag || !isTagged || needsRetagUpfront) && (aiConfig.seamC.enabled || aiConfig.adobe.enabled);

  if (shouldAutoTag) {
    if (isTagged && needsRetagUpfront) {
      const reason = upfrontCompleteness?.isEmptyShell ? 'an empty shell' : 'missing heading tags';
      logger.info(`[PdfAutoTagOrchestrator] PDF claims to be tagged but its structure tree is ${reason} — tagging anyway (${aiConfig.seamC.enabled ? 'Seam C' : 'Adobe'}) for job ${dbJobId}`);
    } else if (isTagged && forceAutoTag) {
      logger.info(`[PdfAutoTagOrchestrator] PDF is already tagged, but forceAutoTag is set — tagging anyway (${aiConfig.seamC.enabled ? 'Seam C' : 'Adobe'}) for job ${dbJobId}`);
    } else {
      logger.info(`[PdfAutoTagOrchestrator] PDF is untagged — tagging (${aiConfig.seamC.enabled ? 'Seam C' : 'Adobe'}) for job ${dbJobId}`);
    }

    // Record autoTagProgress start in job.input
    const ejStart = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
    const eiStart = ejStart?.input && typeof ejStart.input === 'object' && !Array.isArray(ejStart.input)
      ? ejStart.input as Record<string, unknown> : {};
    await prisma.job.update({
      where: { id: dbJobId },
      data: { input: { ...eiStart, autoTagProgress: { startedAt: new Date().toISOString(), status: 'running' } } as Prisma.InputJsonObject },
    });

    // Tags `bufferToTag` with whichever service is available and persists a
    // successful result exactly like a normal tagging pass — sets
    // auditBuffer/autoTagMeta and the job.input progress record. Shared by
    // the primary attempt and the strip-and-retag path below (see
    // alreadyTagged handling) so a successful retag is indistinguishable
    // from a normal first-time tag, bookkeeping-wise.
    const tagAndPersist = async (bufferToTag: Buffer): Promise<void> => {
      let autoTagResult: {
        taggedPdfBuffer: Buffer;
        reportBuffer: Buffer | null;
        wordBuffer: Buffer | null;
        elementCounts: unknown;
        parsedFlags: unknown;
      };
      let taggerSource: 'seam-c' | 'adobe' = 'adobe';
      autoTagResult = await runWithJobHeartbeat(dbJobId, async () => {
        if (aiConfig.seamC.enabled) {
          try {
            const result = await seamCTagService.tagPdf(bufferToTag, dbJobId);
            taggerSource = 'seam-c';
            return result;
          } catch (seamErr) {
            if (!aiConfig.adobe.enabled) throw seamErr;
            logger.warn(`[PdfAutoTagOrchestrator] Seam C tagging failed, falling back to Adobe: ${seamErr instanceof Error ? seamErr.message : String(seamErr)}`);
            return adobeAutoTagService.tagPdf(bufferToTag, { generateReport: true, exportWord: true });
          }
        }
        return adobeAutoTagService.tagPdf(bufferToTag, { generateReport: true, exportWord: true });
      });
      auditBuffer = autoTagResult.taggedPdfBuffer;

      // Save tagged PDF as remediated file + report XML + Word export
      await fileStorageService.saveRemediatedFile(dbJobId, fileName, autoTagResult.taggedPdfBuffer);
      if (autoTagResult.reportBuffer) {
        await fileStorageService.saveFile(dbJobId, 'autotag-report.xlsx', autoTagResult.reportBuffer);
      }
      if (autoTagResult.wordBuffer) {
        const docxName = fileName.replace(/\.pdf$/i, '.docx');
        await fileStorageService.saveFile(dbJobId, docxName, autoTagResult.wordBuffer);
      }

      // Persist autoTagProgress completion in job.input
      const ejDone = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
      const eiDone = ejDone?.input && typeof ejDone.input === 'object' && !Array.isArray(ejDone.input)
        ? ejDone.input as Record<string, unknown> : {};
      const prevProgress = eiDone.autoTagProgress as Record<string, unknown> ?? {};
      await prisma.job.update({
        where: { id: dbJobId },
        data: {
          input: {
            ...eiDone,
            autoTagProgress: {
              ...prevProgress,
              completedAt: new Date().toISOString(),
              status: 'complete',
              elementCounts: autoTagResult.elementCounts,
              adobeFlags: autoTagResult.parsedFlags,
            },
          } as unknown as Prisma.InputJsonObject,
        },
      });

      autoTagMeta = {
        autoTagStatus: 'complete',
        taggerSource,
        hasTaggingReport: !!autoTagResult.reportBuffer,
        hasWordExport: !!autoTagResult.wordBuffer,
        autoTagElementCounts: autoTagResult.elementCounts,
      };
      logger.info(`[PdfAutoTagOrchestrator] ${taggerSource} tagging complete for job ${dbJobId}`);
    };

    try {
      await tagAndPersist(fileBuffer);
    } catch (tagErr) {
      const errMessage = tagErr instanceof Error ? tagErr.message : String(tagErr);
      // Seam C's own struct-tree-builder refuses to run on a document that
      // already has a real /StructTreeRoot (see struct-tree-builder.ts) —
      // re-tagging it would produce duplicate/conflicting MCIDs. That's not
      // a failure: it's the same "don't clobber genuinely good existing
      // structure" outcome as the isTagged pre-check above, just discovered
      // one step later because forceAutoTag (Comparison Study trials) makes
      // the caller attempt tagging instead of pre-emptively skipping it.
      const alreadyTagged = errMessage.startsWith('SEAM_C_ALREADY_TAGGED');

      let completenessMeta: Record<string, unknown> = {};
      let retagSucceeded = false;

      if (alreadyTagged) {
        // Reuse the upfront check (ran when isTagged was true) when we have
        // it -- avoids a redundant pdf-lib parse. Only recompute when this
        // path was reached some other way (shouldn't normally happen given
        // shouldAutoTag's own logic above, but kept as a safe fallback).
        completenessMeta = upfrontCompleteness
          ? { structureTreeCompleteness: upfrontCompleteness }
          : await logStructureCompleteness(fileBuffer, dbJobId);
        const completeness = completenessMeta.structureTreeCompleteness as
          { isEmptyShell: boolean; isHeadingShell: boolean } | undefined;

        // Real incident (Math_Olszewski_PDF.pdf, 2026-10-21): no longer
        // gated behind forceAutoTag -- reachable on every upload now, not
        // just Comparison Study trials. Safe unconditionally because
        // prepareDocumentForRetag's own all-or-nothing bail plus this
        // try/catch's fallback mean a failed attempt here can never leave
        // the document worse off than just using the existing (empty-shell/
        // heading-shell) structure -- only better or unchanged. forceAutoTag
        // keeps its own separate, narrower role above (force a retag even
        // over GENUINELY good structure, for trials only).
        //
        // isHeadingShell alongside isEmptyShell: a tree can clear the
        // isEmptyShell bar on a couple of Figure/P tags while carrying zero
        // heading tags — semanticElements lumps every content type
        // together, so it doesn't see that gap on its own. Without this,
        // fixHeadingHierarchy silently has nothing to rename on a document
        // whose heading-skip issues detection still reports every round.
        if (completeness?.isEmptyShell || completeness?.isHeadingShell) {
          const reason = completeness?.isEmptyShell ? 'an empty shell' : 'missing heading tags';
          logger.info(`[PdfAutoTagOrchestrator] Existing structure is ${reason} — attempting strip-and-retag for job ${dbJobId}`);
          try {
            const doc = await PDFDocument.load(fileBuffer);
            const prepResult = prepareDocumentForRetag(doc);
            if (prepResult.success) {
              const strippedBuffer = Buffer.from(await doc.save());
              await tagAndPersist(strippedBuffer);
              autoTagMeta = { ...autoTagMeta, retagOutcome: 'success', ...completenessMeta };
              logger.info(`[PdfAutoTagOrchestrator] Strip-and-retag succeeded for job ${dbJobId} (${prepResult.pagesStripped}/${prepResult.totalPages} pages stripped)`);
              retagSucceeded = true;
            } else {
              logger.warn(`[PdfAutoTagOrchestrator] Strip-and-retag aborted for job ${dbJobId} — page ${prepResult.bailedOnPage ?? 'n/a'} could not be safely stripped; using existing structure as-is`);
              completenessMeta = { ...completenessMeta, retagOutcome: 'failed-strip-bailed' };
            }
          } catch (retagErr) {
            logger.warn(`[PdfAutoTagOrchestrator] Strip-and-retag failed for job ${dbJobId} (falling back to existing structure): ${retagErr instanceof Error ? retagErr.message : String(retagErr)}`);
            completenessMeta = { ...completenessMeta, retagOutcome: 'failed-retag-error' };
          }
        }

        if (!retagSucceeded) {
          logger.info(`[PdfAutoTagOrchestrator] Document already has real structure — proceeding with audit of existing tagging for job ${dbJobId}`);
        }
      } else {
        logger.warn(`[PdfAutoTagOrchestrator] Adobe AutoTag failed (continuing with untagged): ${errMessage}`);
      }

      if (!retagSucceeded) {
        // Record outcome in job.input
        const ejFail = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
        const eiFail = ejFail?.input && typeof ejFail.input === 'object' && !Array.isArray(ejFail.input)
          ? ejFail.input as Record<string, unknown> : {};
        const prevFail = eiFail.autoTagProgress as Record<string, unknown> ?? {};
        await prisma.job.update({
          where: { id: dbJobId },
          data: { input: { ...eiFail, autoTagProgress: { ...prevFail, completedAt: new Date().toISOString(), status: alreadyTagged ? 'skipped' : 'failed' } } as Prisma.InputJsonObject },
        });

        autoTagMeta = alreadyTagged
          ? { autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged', ...completenessMeta }
          : { autoTagStatus: 'failed', autoTagError: errMessage };
      }
    }
  } else {
    autoTagMeta = isTagged
      ? { autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged', ...(await logStructureCompleteness(fileBuffer, dbJobId)) }
      : { autoTagStatus: 'skipped', autoTagSkipReason: 'no-tagger-configured' };
    if (isTagged) logger.info(`[PdfAutoTagOrchestrator] PDF is already tagged — skipping tagging for job ${dbJobId}`);
    else logger.info(`[PdfAutoTagOrchestrator] No tagger configured — skipping tagging for job ${dbJobId}`);
  }

  return { auditBuffer, isTagged, autoTagMeta };
}
