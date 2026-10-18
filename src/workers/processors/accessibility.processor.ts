import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';
import { pdfAuditService } from '../../services/pdf/pdf-audit.service';
import { autoTagIfNeeded } from '../../services/pdf/pdf-auto-tag-orchestrator.service';
import { createAuditProgressCallbacks } from '../../services/pdf/pdf-audit-progress-tracker';
import { aiAnalysisService } from '../../services/pdf/ai-analysis.service';
import { pdfModifierService } from '../../services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../../services/pdf/pdf-structure-writer.service';
import { fileStorageService } from '../../services/storage/file-storage.service';
import { aiConfig } from '../../config/ai.config';
import { pdfConfig } from '../../config/pdf.config';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// ─── Language utilities (Step 8) ─────────────────────────────────────────────

/**
 * Normalise a malformed BCP-47 language code to its correct lowercase form.
 * Handles common issues from PDF authoring tools that uppercase the code.
 */
function normalizeLanguageCode(code: string): string {
  const map: Record<string, string> = {
    EN: 'en', 'EN-US': 'en-US', 'EN-GB': 'en-GB',
    FR: 'fr', DE: 'de', ZH: 'zh', AR: 'ar',
    ES: 'es', IT: 'it', JA: 'ja', KO: 'ko',
    PT: 'pt', NL: 'nl', RU: 'ru', PL: 'pl',
  };
  return map[code.toUpperCase()] ?? code;
}

/**
 * Detect the document language from a tagged PDF.
 * Priority: (1) existing catalog /Lang → (2) most common Lang attribute on paragraph elements → (3) undefined
 * Returns undefined when no language can be detected — callers must not auto-apply 'en' in that case.
 */
function detectDocumentLanguage(doc: PDFDocument): string | undefined {
  try {
    // 1. Existing /Lang on catalog
    const catalogLang = doc.catalog.get(PDFName.of('Lang'));
    if (catalogLang instanceof PDFString) {
      const code = catalogLang.decodeText().trim();
      if (code.length > 0) return normalizeLanguageCode(code);
    }

    // 2. Most frequent Lang attribute on structure elements
    const langCounts: Record<string, number> = {};
    const structRoot = doc.catalog.get(PDFName.of('StructTreeRoot'));
    if (structRoot) {
      collectLangAttributes(doc.context.lookup(structRoot), doc, langCounts);
    }
    if (Object.keys(langCounts).length > 0) {
      const detected = Object.entries(langCounts).sort(([, a], [, b]) => b - a)[0][0];
      const nonEnglish = detected !== 'en' && !detected.startsWith('en-');
      if (nonEnglish) {
        logger.warn(`[PDF Worker] Detected non-English language from structure elements: ${detected}`);
      }
      return normalizeLanguageCode(detected);
    }
  } catch (e) {
    logger.debug(`[PDF Worker] detectDocumentLanguage failed: ${e}`);
  }

  // 3. No language detected — return undefined so the caller skips the write
  logger.debug('[PDF Worker] No language detected; skipping automatic language write');
  return undefined;
}

function collectLangAttributes(
  node: unknown,
  doc: PDFDocument,
  counts: Record<string, number>,
  depth = 0
): void {
  if (depth > 50 || !node) return;
  if (node instanceof PDFRef) {
    collectLangAttributes(doc.context.lookup(node), doc, counts, depth + 1);
    return;
  }
  if (node instanceof PDFArray) {
    for (let i = 0; i < node.size(); i++) collectLangAttributes(node.get(i), doc, counts, depth + 1);
    return;
  }
  if (node instanceof PDFDict) {
    const lang = node.get(PDFName.of('Lang'));
    if (lang instanceof PDFString) {
      const code = lang.decodeText().trim();
      if (code.length > 0) counts[code] = (counts[code] ?? 0) + 1;
    }
    const k = node.get(PDFName.of('K'));
    if (k) collectLangAttributes(k, doc, counts, depth + 1);
  }
}

export interface TimingSummary {
  /** Wall-clock from Job.startedAt to whenever this summary is computed (job completion). */
  totalMs: number | null;
  autoTagMs: number | null;
  /** No explicit start/end markers of its own -- inferred as whatever ran
   * between auto-tagging (if any) finishing and the first validator starting. */
  extractionMs: number | null;
  /** Keyed by validator label ("Structure & Tags", "Alt Text", etc.), ms each took. */
  validators: Record<string, number>;
  totalPages: number | null;
  totalImages: number | null;
  fileSizeBytes: number | null;
  computedAt: string;
}

/**
 * Pure rollup of every timing signal already written to Job.input over the
 * course of an audit (validatorProgress, totalPages, altTextImageProgress,
 * autoTagProgress) into one flat, query-ready record. Kept pure (no Prisma
 * calls) so it's directly unit-testable without mocking the DB -- see
 * accessibility.processor.timing-summary.test.ts.
 */
export function computeTimingSummary(input: Record<string, unknown>, jobStartedAt: Date | null): TimingSummary {
  const validatorEntries = Array.isArray(input.validatorProgress)
    ? input.validatorProgress as Array<{ label: string; startedAt: string; completedAt: string }>
    : [];
  const autoTag = input.autoTagProgress as { startedAt?: string; completedAt?: string } | undefined;
  const altTextTotal = (input.altTextImageProgress as { total?: number } | undefined)?.total ?? null;

  const validators: Record<string, number> = {};
  for (const v of validatorEntries) {
    validators[v.label] = new Date(v.completedAt).getTime() - new Date(v.startedAt).getTime();
  }

  const extractionStart = autoTag?.completedAt ?? jobStartedAt?.toISOString();
  const firstValidatorStart = validatorEntries[0]?.startedAt;
  const extractionMs = extractionStart && firstValidatorStart
    ? new Date(firstValidatorStart).getTime() - new Date(extractionStart).getTime()
    : null;

  const totalMs = jobStartedAt ? Date.now() - jobStartedAt.getTime() : null;
  const autoTagMs = autoTag?.startedAt && autoTag?.completedAt
    ? new Date(autoTag.completedAt).getTime() - new Date(autoTag.startedAt).getTime()
    : null;

  return {
    totalMs,
    autoTagMs,
    extractionMs,
    validators,
    totalPages: (input.totalPages as number | undefined) ?? null,
    totalImages: altTextTotal,
    fileSizeBytes: (input.size as number | undefined) ?? null,
    computedAt: new Date().toISOString(),
  };
}

export async function processAccessibilityJob(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { type, fileId } = job.data;
  const jobId = job.id || job.name;

  logger.info(`[Accessibility] Starting ${type} for file: ${fileId ?? 'n/a'}`);

  await job.updateProgress(10);
  await queueService.updateJobProgress(jobId, 10);

  switch (type) {
    case JOB_TYPES.PDF_ACCESSIBILITY:
      return await processPdfAccessibility(job);

    case JOB_TYPES.EPUB_ACCESSIBILITY:
      return await processEpubAccessibility(job);

    case JOB_TYPES.BATCH_VALIDATION:
      return await processBatchValidation(job);

    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

async function processPdfAccessibility(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { options, tenantId, userId } = job.data;
  // dbJobId and BullMQ job.id are the same (we pass jobId when enqueueing)
  const dbJobId = (options?.dbJobId as string) || (job.id || job.name);
  const fileName = (options?.fileName as string) || 'document.pdf';

  // ── 1. Load file [10–20%] ───────────────────────────────────────────────────
  logger.info(`[PDF Worker] Loading file for job ${dbJobId}`);
  const fileBuffer = await fileStorageService.getFile(dbJobId, fileName);
  if (!fileBuffer) {
    throw new Error(`PDF file not found in storage for job ${dbJobId}`);
  }

  // Fail fast on an oversized file BEFORE spending any real work on it.
  // Real incident (2026-09-25): a 1.43GB comparison-study PDF ran through
  // ~3 minutes of genuine Adobe/Seam-C auto-tagging before the SAME limit
  // check (buried inside pdfParserService.parseBuffer, called later via
  // pdfAuditService.runAuditFromBuffer) finally failed the job -- because
  // the ONLY earlier size check (in the "quick tagged check" below) has its
  // failure silently swallowed and treated as "assume untagged", not
  // propagated. Checking here, unconditionally, means an oversized file
  // fails in milliseconds instead of minutes, every time.
  const fileSizeMB = fileBuffer.length / (1024 * 1024);
  if (fileSizeMB > pdfConfig.maxFileSizeMB) {
    throw new Error(`PDF file exceeds maximum size of ${pdfConfig.maxFileSizeMB}MB`);
  }

  await job.updateProgress(20);
  await queueService.updateJobProgress(dbJobId, 20);

  // ── 2. Seam C / Adobe AutoTag if untagged [20–40%] ──────────────────────────
  // forceAutoTag bypasses the isTagged check. It exists for Comparison Study
  // trials specifically: the /MarkInfo /Marked flag isTagged relies on only
  // means a PDF *claims* structure — plenty of real documents set it while
  // having minimal/poor tagging. Skipping re-tagging on that basis is a
  // reasonable default for regular uploads (avoids clobbering genuinely good
  // existing structure), but it silently defeats a trial's whole purpose:
  // measuring what Ninja's pipeline actually produces against pdfxt on the
  // same starting document.
  const forceAutoTag = Boolean(options?.forceAutoTag);
  const { auditBuffer: taggedBuffer, isTagged, autoTagMeta } = await autoTagIfNeeded(fileBuffer, dbJobId, fileName, forceAutoTag);
  let auditBuffer = taggedBuffer;
  const shouldAutoTag = (forceAutoTag || !isTagged) && (aiConfig.seamC.enabled || aiConfig.adobe.enabled);

  // Advance to audit start (40% if auto-tag ran, stays at 20% if skipped)
  const auditStartPct = shouldAutoTag ? 40 : 20;
  const auditPctRange = 88 - auditStartPct;
  await job.updateProgress(auditStartPct);
  await queueService.updateJobProgress(dbJobId, auditStartPct);

  // ── 3. Run accessibility audit [auditStartPct–88%] ──────────────────────────
  // Progress callbacks (page/validator/alt-text-image progress, all written
  // into job.input + job.progress so GET /jobs/:id can report them) are
  // shared with pdf-batch-orchestrator.service.ts -- see
  // pdf-audit-progress-tracker.ts's own doc comment for the real incident
  // (a 377-page document, an unhandled rejection with no global handler,
  // a full container restart mid-audit) that makes every callback here
  // swallow its own errors instead of ever rejecting.
  const { onProgress, onValidatorComplete, onAltTextImageProgress, getLastKnownPercent } = createAuditProgressCallbacks({
    jobId: dbJobId,
    extractionStartPct: auditStartPct,
    extractionPctRange: auditPctRange,
    onPercent: (pct) => job.updateProgress(pct),
  });

  logger.info(`[PDF Worker] Running audit for job ${dbJobId}, file: ${fileName}`);
  const scanLevel = 'comprehensive';

  // General heartbeat for the whole audit call, not just Alt Text. Real
  // incident (2026-09-26): PdfFormulaValidator and PdfFigureStructTreeValidator
  // (pdf-audit.service.ts's "bonus sub-check" validators, deliberately excluded
  // from onValidatorComplete's progress total) ran between Alt Text and Color
  // Contrast for 18+ minutes with zero signal to the job, and the stale-job
  // watchdog killed it 36 SECONDS before Color Contrast finished and would have
  // reported in on its own -- the underlying work kept running regardless
  // (this DB write can't cancel the in-flight promise chain) and eventually
  // completed successfully, silently flipping status back from FAILED to
  // COMPLETED minutes later. Rather than keep hunting down and individually
  // instrumenting every current and future slow, unmonitored sub-step the way
  // Alt Text's per-image progress was, this touches Job.updatedAt on a fixed
  // interval for the ENTIRE runAuditFromBuffer call regardless of which
  // validator (named or "bonus") is currently executing.
  //
  // Two CodeRabbit findings on the first version of this fix, both real:
  //
  // 1. (P1) An unbounded heartbeat masks a GENUINELY hung job forever --
  //    e.g. a validator or DB call truly deadlocked, not just slow --
  //    since cleanupStalePdfJobs (src/workers/index.ts) would never see a
  //    stale updatedAt again. MAX_HEARTBEAT_MS caps how long the heartbeat
  //    keeps refreshing; past that, it stops and the normal 20-minute
  //    watchdog can catch a truly stuck job again. Set well above the
  //    longest legitimate run observed so far (~4h12m total, ~3h37m of
  //    that in Alt Text alone, on a 3843-image document).
  //
  // 2. (Major) clearInterval only stops FUTURE ticks -- an already-in-flight
  //    write isn't cancelled by it, and could otherwise land after the
  //    audit resolves and progress is set to 100/COMPLETED, regressing it
  //    back to a stale lastKnownPct with a misleadingly later updatedAt.
  //    inFlightHeartbeat is awaited in the finally block so the very last
  //    write (if any) is always settled before this function moves on.
  const HEARTBEAT_MS = 2 * 60 * 1000; // 10x margin under the 20-min watchdog threshold
  const MAX_HEARTBEAT_MS = 6 * 60 * 60 * 1000; // well above the longest legitimate run observed so far
  const heartbeatStartedAt = Date.now();
  let inFlightHeartbeat: Promise<void> | null = null;
  const heartbeatInterval = setInterval(() => {
    if (Date.now() - heartbeatStartedAt >= MAX_HEARTBEAT_MS) {
      logger.warn(`[PDF Worker] Heartbeat for job ${dbJobId} exceeded ${MAX_HEARTBEAT_MS / 60000}min cap -- stopping so the stale-job watchdog can resume authority`);
      clearInterval(heartbeatInterval);
      return;
    }
    inFlightHeartbeat = queueService.updateJobProgress(dbJobId, getLastKnownPercent()).catch(err => {
      logger.warn(`[PDF Worker] Heartbeat update failed for job ${dbJobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }, HEARTBEAT_MS);

  let auditReport;
  try {
    auditReport = await pdfAuditService.runAuditFromBuffer(
      auditBuffer,
      dbJobId,
      fileName,
      scanLevel,
      undefined,
      onProgress,
      onValidatorComplete,
      onAltTextImageProgress,
    );
  } finally {
    clearInterval(heartbeatInterval);
    if (inFlightHeartbeat) await inFlightHeartbeat;
  }
  logger.info(`[PDF Worker] Audit complete for job ${dbJobId}`);

  // ── 3b. Post-audit auto-applies [non-fatal] ──────────────────────────────────
  // Apply deterministic fixes that don't require human review:
  //   - Language (PDF-NO-LANGUAGE) — detect from structure tree, write /Lang
  //   - PDF/UA identifier (PDFUA-IDENTIFIER-MISSING) — write pdfuaid:part=1 to XMP
  //   - Title derivation (01-001..01-004) — set title, DisplayDocTitle, dc:title
  // Each fix re-saves the remediated buffer; failures are non-fatal.
  try {
    const issues = (auditReport as unknown as { issues?: Array<{ code: string }> }).issues ?? [];
    const issueCodes = new Set(issues.map(i => i.code));

    const hasMissingLang =
      issueCodes.has('PDF-NO-LANGUAGE') ||
      issueCodes.has('PDF-LANGUAGE-MALFORMED') ||
      issueCodes.has('MATTERHORN-11-001');
    const hasMissingPdfUa = issueCodes.has('PDFUA-IDENTIFIER-MISSING');
    const hasMissingTitle =
      issueCodes.has('PDF-NO-TITLE') ||
      issueCodes.has('PDF-TITLE-EMPTY') ||
      issueCodes.has('PDF-DISPLAY-TITLE') ||
      issueCodes.has('PDF-XMP-TITLE-MISSING') ||
      issueCodes.has('WCAG-2.4.2');
    const hasMissingBookmarks = issueCodes.has('BOOKMARK-MISSING');
    const needsAutoFix = hasMissingLang || hasMissingPdfUa || hasMissingTitle || hasMissingBookmarks;

    if (needsAutoFix) {
      const autoFixDoc = await pdfModifierService.loadPDF(auditBuffer);
      let autoFixApplied = false;

      if (hasMissingLang) {
        const detectedLang = detectDocumentLanguage(autoFixDoc);
        if (detectedLang) {
          const result = await pdfModifierService.addLanguage(autoFixDoc, detectedLang);
          logger.info(`[PDF Worker] Auto-applied language '${detectedLang}' for job ${dbJobId}: ${result.success}`);
          if (result.success) autoFixApplied = true;
        } else {
          logger.info(`[PDF Worker] Skipping language auto-fix for job ${dbJobId}: could not detect document language`);
        }
      }

      if (hasMissingPdfUa) {
        const result = await pdfModifierService.writePdfUaIdentifier(autoFixDoc);
        logger.info(`[PDF Worker] Auto-applied PDF/UA identifier for job ${dbJobId}: ${result.success}`);
        if (result.success) autoFixApplied = true;
      }

      if (hasMissingTitle) {
        const fileNameStem = fileName.replace(/\.pdf$/i, '');
        const result = await pdfModifierService.deriveAndSetTitle(autoFixDoc, fileNameStem);
        logger.info(`[PDF Worker] Auto-derived title for job ${dbJobId}: ${result.success}, value: ${result.after}`);
        if (result.success) autoFixApplied = true;
      }

      if (hasMissingBookmarks) {
        const { generated } = pdfStructureWriterService.generateBookmarksFromHeadings(autoFixDoc);
        if (generated > 0) {
          logger.info(`[PDF Worker] Auto-generated ${generated} bookmarks for job ${dbJobId}`);
          autoFixApplied = true;
        } else {
          logger.debug(`[PDF Worker] Bookmark auto-generate skipped for job ${dbJobId}: no H1-H6 structure elements found`);
        }
      }

      if (autoFixApplied) {
        const fixedBuffer = await pdfModifierService.savePDF(autoFixDoc);
        await fileStorageService.saveRemediatedFile(dbJobId, fileName, fixedBuffer);
        auditBuffer = fixedBuffer;
        logger.info(`[PDF Worker] Post-audit auto-fixes saved for job ${dbJobId}`);
      }
    }
  } catch (autoFixErr) {
    logger.warn(`[PDF Worker] Post-audit auto-fix failed (non-fatal): ${autoFixErr instanceof Error ? autoFixErr.message : String(autoFixErr)}`);
  }

  // ── 4. Create AcrJob record (non-fatal) ─────────────────────────────────────
  try {
    await prisma.acrJob.create({
      data: { jobId: dbJobId, tenantId, userId, edition: 'WCAG21-AA', documentTitle: fileName, documentType: 'PDF', status: 'draft' },
    });
  } catch (acrErr) {
    logger.warn(`[PDF Worker] Failed to create AcrJob (non-fatal): ${acrErr instanceof Error ? acrErr.message : String(acrErr)}`);
  }

  // ── 5. AI Analysis — fire-and-forget [95%+] ─────────────────────────────────
  // Delayed 3s to allow base.worker to mark the job COMPLETED and write job.output
  // before analyzeJob() reads issues from the DB.
  const aiStartedAt = new Date().toISOString();
  setTimeout(() => {
    aiAnalysisService.analyzeJob(dbJobId, tenantId)
      .then(({ analyzed, skipped, serviceDegraded, serviceError }) => {
        if (serviceDegraded) {
          logger.error(
            `[PDF Worker] AI Analysis for job ${dbJobId}: ${analyzed} analyzed, ${skipped} skipped — AI SERVICE DEGRADED: ${serviceError}`
          );
        } else {
          logger.info(`[PDF Worker] AI Analysis for job ${dbJobId}: ${analyzed} analyzed, ${skipped} skipped`);
        }
        // Estimate token usage: ~700 tokens per analyzed issue (Gemini Flash + Claude Haiku mix)
        const tokensUsed = analyzed * 700;
        const estimatedCostUsd = parseFloat((tokensUsed * 0.000000375).toFixed(4));
        prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } })
          .then(ej => {
            const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
              ? ej.input as Record<string, unknown> : {};
            return prisma.job.update({
              where: { id: dbJobId },
              data: {
                input: {
                  ...ei,
                  aiAnalysisProgress: { startedAt: aiStartedAt, completedAt: new Date().toISOString(), analyzed, skipped, tokensUsed, estimatedCostUsd },
                } as Prisma.InputJsonObject,
              },
            });
          })
          .catch(() => {});
      })
      .catch(err => {
        logger.warn(`[PDF Worker] AI Analysis failed for job ${dbJobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
  }, 3000);

  // Roll up every timing signal collected above into one flat, query-ready
  // record -- the goal (per user direction, 2026-09-26) is enough real data
  // per-title, per-step, to eventually estimate audit time from a new
  // upload's page/image count before running it. The raw pieces
  // (validatorProgress, totalPages, altTextImageProgress, autoTagProgress)
  // already exist scattered across job.input; this is the same data,
  // computed once at completion so a later analysis doesn't have to re-parse
  // and re-derive it from every single Job row by hand.
  try {
    const ej = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true, startedAt: true } });
    const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
      ? ej.input as Record<string, unknown> : {};

    await prisma.job.update({
      where: { id: dbJobId },
      data: {
        input: {
          ...ei,
          timingSummary: computeTimingSummary(ei, ej?.startedAt ?? null),
        } as unknown as Prisma.InputJsonObject,
      },
    });
  } catch (err) {
    logger.warn(`[PDF Worker] Failed to compute timingSummary for job ${dbJobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  await job.updateProgress(100);
  await queueService.updateJobProgress(dbJobId, 100);

  // Return the full audit report in result.data so the base.worker wrapper
  // can persist it as job.output. Do NOT call prisma.job.update here —
  // base.worker handles the COMPLETED status + output write to avoid overwriting.
  return {
    success: true,
    data: {
      fileName,
      auditReport: auditReport as unknown as Record<string, unknown>,
      scanLevel,
      type: 'PDF_ACCESSIBILITY',
      dbJobId,
      timestamp: new Date().toISOString(),
      ...autoTagMeta,
    },
  };
}

async function processEpubAccessibility(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  await simulateProcessing(job, jobId, [
    { progress: 20, message: 'Parsing EPUB structure' },
    { progress: 40, message: 'Validating EPUB 3 accessibility' },
    { progress: 60, message: 'Checking navigation elements' },
    { progress: 80, message: 'Analyzing media overlays' },
    { progress: 100, message: 'Generating report' },
  ]);

  return {
    success: true,
    data: {
      type: 'EPUB_ACCESSIBILITY',
      validationComplete: true,
      issuesFound: 0,
      passedChecks: 12,
      totalChecks: 12,
      score: 100,
      timestamp: new Date().toISOString(),
    },
  };
}

async function processBatchValidation(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  await simulateProcessing(job, jobId, [
    { progress: 25, message: 'Processing batch items' },
    { progress: 50, message: 'Running validations' },
    { progress: 75, message: 'Aggregating results' },
    { progress: 100, message: 'Complete' },
  ]);

  return {
    success: true,
    data: {
      type: 'BATCH_VALIDATION',
      totalProcessed: 1,
      successful: 1,
      failed: 0,
      timestamp: new Date().toISOString(),
    },
  };
}

async function simulateProcessing(
  job: Job<JobData, JobResult>,
  jobId: string,
  stages: Array<{ progress: number; message: string }>
): Promise<void> {
  for (const stage of stages) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await job.updateProgress(stage.progress);
    await queueService.updateJobProgress(jobId, stage.progress);
    logger.info(`  [Worker] ${stage.message}`);
  }
}
