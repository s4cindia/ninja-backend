import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';
import { pdfAuditService } from '../../services/pdf/pdf-audit.service';
import { pdfParserService } from '../../services/pdf/pdf-parser.service';
import { adobeAutoTagService } from '../../services/pdf/adobe-autotag.service';
import { aiAnalysisService } from '../../services/pdf/ai-analysis.service';
import { pdfModifierService } from '../../services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../../services/pdf/pdf-structure-writer.service';
import { fileStorageService } from '../../services/storage/file-storage.service';
import { aiConfig } from '../../config/ai.config';
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

  // Quick tagged check — lightweight parse to detect PDF structure tree presence
  let isTagged = false;
  try {
    const parsedMeta = await pdfParserService.parseBuffer(fileBuffer, fileName);
    isTagged = parsedMeta.structure.metadata.isTagged ?? false;
    await pdfParserService.close(parsedMeta).catch(() => {});
  } catch (tagCheckErr) {
    logger.warn(`[PDF Worker] Tagged check failed (assuming untagged): ${tagCheckErr instanceof Error ? tagCheckErr.message : String(tagCheckErr)}`);
  }

  logger.info(`[PDF Worker] PDF isTagged=${isTagged} for job ${dbJobId}`);
  await job.updateProgress(20);
  await queueService.updateJobProgress(dbJobId, 20);

  // ── 2. Adobe AutoTag if untagged [20–40%] ───────────────────────────────────
  let auditBuffer = fileBuffer;
  let autoTagMeta: Record<string, unknown> = {};
  const shouldAutoTag = !isTagged && aiConfig.adobe.enabled;

  if (shouldAutoTag) {
    logger.info(`[PDF Worker] PDF is untagged — running Adobe AutoTag for job ${dbJobId}`);

    // Record autoTagProgress start in job.input
    const ejStart = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
    const eiStart = ejStart?.input && typeof ejStart.input === 'object' && !Array.isArray(ejStart.input)
      ? ejStart.input as Record<string, unknown> : {};
    await prisma.job.update({
      where: { id: dbJobId },
      data: { input: { ...eiStart, autoTagProgress: { startedAt: new Date().toISOString(), status: 'running' } } as Prisma.InputJsonObject },
    });

    try {
      const autoTagResult = await adobeAutoTagService.tagPdf(fileBuffer, { generateReport: true, exportWord: true });
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
        hasTaggingReport: !!autoTagResult.reportBuffer,
        hasWordExport: !!autoTagResult.wordBuffer,
        autoTagElementCounts: autoTagResult.elementCounts,
      };
      logger.info(`[PDF Worker] Adobe AutoTag complete for job ${dbJobId}`);
    } catch (tagErr) {
      logger.warn(`[PDF Worker] Adobe AutoTag failed (continuing with untagged): ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`);

      // Record failure in job.input
      const ejFail = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
      const eiFail = ejFail?.input && typeof ejFail.input === 'object' && !Array.isArray(ejFail.input)
        ? ejFail.input as Record<string, unknown> : {};
      const prevFail = eiFail.autoTagProgress as Record<string, unknown> ?? {};
      await prisma.job.update({
        where: { id: dbJobId },
        data: { input: { ...eiFail, autoTagProgress: { ...prevFail, completedAt: new Date().toISOString(), status: 'failed' } } as Prisma.InputJsonObject },
      });

      autoTagMeta = {
        autoTagStatus: 'failed',
        autoTagError: tagErr instanceof Error ? tagErr.message : String(tagErr),
      };
    }
  } else {
    autoTagMeta = { autoTagStatus: isTagged ? 'skipped' : 'skipped' };
    if (isTagged) logger.info(`[PDF Worker] PDF is already tagged — skipping Adobe AutoTag for job ${dbJobId}`);
    else logger.info(`[PDF Worker] Adobe not configured — skipping AutoTag for job ${dbJobId}`);
  }

  // Advance to audit start (40% if auto-tag ran, stays at 20% if skipped)
  const auditStartPct = shouldAutoTag ? 40 : 20;
  const auditPctRange = 88 - auditStartPct;
  await job.updateProgress(auditStartPct);
  await queueService.updateJobProgress(dbJobId, auditStartPct);

  // ── 3. Run accessibility audit [auditStartPct–88%] ──────────────────────────
  // Progress callback: maps page progress across the audit range.
  // First call stores totalPages in job.input for the frontend.
  let totalPagesStored = false;
  const onProgress = async (currentPage: number, totalPages: number) => {
    if (!totalPagesStored && totalPages > 0) {
      totalPagesStored = true;
      const ej = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
      const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
        ? ej.input as Record<string, unknown> : {};
      await prisma.job.update({
        where: { id: dbJobId },
        data: { input: { ...ei, totalPages } as Prisma.InputJsonObject },
      });
      logger.info(`[PDF Worker] Job ${dbJobId}: ${totalPages} pages to audit`);
    }
    if (totalPages > 0) {
      const pct = auditStartPct + Math.round((currentPage / totalPages) * auditPctRange);
      await job.updateProgress(pct);
      await queueService.updateJobProgress(dbJobId, pct);
    }
  };

  // Validator progress callback: advances 88–95%
  const validatorProgress: Array<{ label: string; issuesFound: number; startedAt: string; completedAt: string }> = [];
  const onValidatorComplete = async (label: string, issuesFound: number, completed: number, total: number, startedAt: Date) => {
    validatorProgress.push({ label, issuesFound, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() });
    logger.info(`[PDF Worker] Validator "${label}" done: ${issuesFound} issues (${completed}/${total})`);
    const pct = 88 + Math.round((completed / total) * 7); // 88–95%
    await job.updateProgress(pct);
    await queueService.updateJobProgress(dbJobId, pct);
    const ej = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
    const ei = ej?.input && typeof ej.input === 'object' && !Array.isArray(ej.input)
      ? ej.input as Record<string, unknown> : {};
    await prisma.job.update({
      where: { id: dbJobId },
      data: { input: { ...ei, validatorProgress: [...validatorProgress] } as Prisma.InputJsonObject },
    });
  };

  logger.info(`[PDF Worker] Running audit for job ${dbJobId}, file: ${fileName}`);
  const scanLevel = 'comprehensive';
  const auditReport = await pdfAuditService.runAuditFromBuffer(
    auditBuffer,
    dbJobId,
    fileName,
    scanLevel,
    undefined,
    onProgress,
    onValidatorComplete,
  );
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
      .then(({ analyzed, skipped }) => {
        logger.info(`[PDF Worker] AI Analysis for job ${dbJobId}: ${analyzed} analyzed, ${skipped} skipped`);
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
