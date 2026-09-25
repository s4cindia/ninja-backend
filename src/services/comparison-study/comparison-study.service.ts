/**
 * Comparison Study Service
 *
 * Backend for the pdfxt-vs-Ninja validation study: register a fresh
 * document, run it through the normal Ninja audit/remediation pipeline,
 * log the operator's pdfxt run against the same document, validate both
 * outputs with veraPDF (the same neutral tool on both sides), and report
 * the comparison.
 *
 * ComparisonTrial deliberately has no relation to CorpusDocument or the
 * training pipeline — see prisma/schema.prisma for why.
 */

import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ComparisonTrial, ExternalPacReport, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';
import { fileStorageService } from '../storage/file-storage.service';
import { veraPdfService, VeraPdfValidationResult } from '../pdf/verapdf.service';
import { createAndEnqueuePdfAuditJob } from '../../controllers/pdf.controller';
import { AppError } from '../../utils/app-error';

const COMPARISON_STUDY_PREFIX = 'comparison-study/';
// Comparison-study source PDFs can be large (tens of MB); 300s was too
// short for a slow-connection upload to finish before the presigned URL
// expired, causing S3 to reject the PUT with 403 partway through.
const UPLOAD_URL_EXPIRY_SECONDS = 30 * 60;

export interface PresignedUploadResult {
  uploadUrl: string;
  s3Key: string;
  expiresAt: string;
}

/** Presigned PUT URL for an operator to upload a source PDF or a pdfxt output directly to S3. */
export async function generateUploadUrl(
  filename: string,
  contentType = 'application/pdf',
): Promise<PresignedUploadResult> {
  const sanitised = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  const s3Key = `${COMPARISON_STUDY_PREFIX}${Date.now()}-${sanitised}`;
  const command = new PutObjectCommand({ Bucket: config.s3Bucket, Key: s3Key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, s3Key, expiresAt: new Date(Date.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000).toISOString() };
}

/**
 * Register a trial: point at an already-uploaded source PDF (via
 * generateUploadUrl) and kick off a normal Ninja audit job for it — the
 * SAME job-creation/enqueue path as every other PDF upload (see
 * createAndEnqueuePdfAuditJob), so the trial's Ninja side is a real job,
 * not a special case.
 *
 * Real incident (2026-09-25): this used to call s3Service.getFileBuffer to
 * download the whole just-uploaded PDF into memory, purely to read its byte
 * length and hand the buffer to createAndEnqueuePdfAuditJob, which then
 * re-uploaded that same buffer to a different S3 key -- a full
 * download+reupload round trip inside this single HTTP request/response
 * cycle. For a large PDF that round trip could exceed the server's own
 * request timeout or exhaust memory, dropping the connection before ever
 * responding -- surfaced to the operator as a generic "Network Error" on
 * Register Trial (axios's own message for a request that got no response
 * at all). Now reads the size via a cheap HEAD request and passes the
 * existing S3 key through so createAndEnqueuePdfAuditJob can do a
 * server-side S3-to-S3 copy instead (see saveFileFromS3Key).
 */
export async function registerTrial(input: {
  sourceFileName: string;
  sourceS3Key: string;
  contentType: string;
  operatorId: string;
  tenantId: string;
  userId: string;
}): Promise<ComparisonTrial> {
  const size = await s3Service.getFileSize(input.sourceS3Key);

  const { jobId } = await createAndEnqueuePdfAuditJob(
    {
      originalname: input.sourceFileName,
      mimetype: 'application/pdf',
      size,
    },
    input.tenantId,
    input.userId,
    // A trial exists to measure what Ninja's pipeline actually produces
    // against pdfxt on the same document — skipping Seam-C because the
    // source PDF's /MarkInfo /Marked flag happens to be set (which says
    // nothing about whether the existing tagging is any good) would
    // silently defeat that comparison.
    { forceAutoTag: true, sourceS3Key: input.sourceS3Key },
  );

  const trial = await prisma.comparisonTrial.create({
    data: {
      sourceFileName: input.sourceFileName,
      sourceS3Path: input.sourceS3Key,
      contentType: input.contentType,
      operatorId: input.operatorId,
      ninjaJobId: jobId,
      status: 'registered',
    },
  });

  logger.info(`[ComparisonStudy] Registered trial ${trial.id} for ${input.sourceFileName} (job ${jobId})`);
  return trial;
}

export async function listTrials(opts: {
  status?: string;
  contentType?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ trials: ComparisonTrial[]; nextCursor: string | null }> {
  const { limit = 20, cursor, status, contentType } = opts;
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (contentType) where.contentType = contentType;

  const trials = await prisma.comparisonTrial.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' },
  });

  const hasMore = trials.length > limit;
  const items = hasMore ? trials.slice(0, limit) : trials;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  return { trials: items, nextCursor };
}

export async function getTrial(id: string): Promise<
  | (ComparisonTrial & { job: { id: string; status: string; output: unknown } | null })
  | null
> {
  return prisma.comparisonTrial.findUnique({
    where: { id },
    include: { job: { select: { id: true, status: true, output: true } } },
  });
}

/**
 * Delete a trial — e.g. a dry-run used to smoke-test the workflow itself,
 * rather than a real validation trial on a fresh document. Only removes
 * the ComparisonTrial row: the underlying Ninja Job (and its own audit/
 * remediation data) is untouched, since it's a normal job independent of
 * this study. Returns false if the trial doesn't exist rather than throwing,
 * so a repeat/late delete request is a no-op instead of an error.
 */
export async function deleteTrial(id: string): Promise<boolean> {
  try {
    await prisma.comparisonTrial.delete({ where: { id } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return false;
    }
    throw err;
  }
}

/** Log the operator's pdfxt-side result: stopwatch time, page count, cost, and the output file's S3 key. */
export async function logPdfxtData(
  id: string,
  input: {
    pdfxtS3Key?: string;
    pdfxtTimeMs?: number;
    pdfxtPageCount?: number;
    pdfxtCostUsd?: number;
  },
): Promise<ComparisonTrial> {
  return prisma.comparisonTrial.update({
    where: { id },
    data: {
      ...(input.pdfxtS3Key !== undefined && { pdfxtS3Path: input.pdfxtS3Key }),
      ...(input.pdfxtTimeMs !== undefined && { pdfxtTimeMs: input.pdfxtTimeMs }),
      ...(input.pdfxtPageCount !== undefined && { pdfxtPageCount: input.pdfxtPageCount }),
      ...(input.pdfxtCostUsd !== undefined && { pdfxtCostUsd: input.pdfxtCostUsd }),
      status: 'pdfxt_logged',
    },
  });
}

/**
 * Update a trial's auto-remediation-mode configuration (manual/auto toggle,
 * round-count and cumulative Gemini $ cost ceilings). Rejects changing
 * `mode` while a run is already in progress -- switching a trial out of
 * auto mode mid-run would orphan the loop's own state machine, which reads
 * `mode`/ceilings fresh from this row on every round.
 */
export async function updateAutoModeConfig(
  id: string,
  input: {
    mode?: 'manual' | 'auto';
    autoMaxRounds?: number;
    autoCostLimitUsd?: number;
    // null explicitly reverts to "inherit tenant/default config" -- the
    // same state every trial starts in (the column has no default).
    autoColorContrastMode?: 'guidance-only' | 'disabled' | 'apply-to-pdf' | null;
  },
): Promise<ComparisonTrial> {
  const trial = await prisma.comparisonTrial.findUnique({ where: { id } });
  if (!trial) {
    throw AppError.notFound('Trial not found');
  }

  if (input.mode !== undefined && input.mode !== trial.mode && trial.autoStatus === 'running') {
    throw AppError.conflict(
      'Cannot change mode while an auto-remediation run is in progress. Stop it first.',
      'AUTO_MODE_RUNNING',
    );
  }

  return prisma.comparisonTrial.update({
    where: { id },
    data: {
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(input.autoMaxRounds !== undefined && { autoMaxRounds: input.autoMaxRounds }),
      ...(input.autoCostLimitUsd !== undefined && { autoCostLimitUsd: input.autoCostLimitUsd }),
      ...(input.autoColorContrastMode !== undefined && { autoColorContrastMode: input.autoColorContrastMode }),
    },
  });
}

/**
 * Write a buffer to a scratch temp file and run veraPDF against it — veraPDF
 * is a CLI tool, it needs a real path.
 *
 * Returns the full { ran, failures } result, not just the failures array —
 * CodeRabbit finding on PR #577, confirmed real: this study persists the
 * result directly into ComparisonTrial.ninjaPacResult/pdfxtPacResult, and
 * getTrialReport() later reads `Array.isArray(...) ? .length : null` to
 * compute pacFailureCount. Persisting just an empty array (the old
 * behaviour) made "veraPDF was unavailable/timed out for this trial" and
 * "veraPDF ran and found zero failures" both look like a clean pass —
 * exactly the ran-vs-found-nothing ambiguity this whole PR's other fix was
 * about, in a second, independent place it also applies.
 */
async function runVeraPdf(buffer: Buffer, label: string): Promise<VeraPdfValidationResult> {
  if (!veraPdfService.isAvailable()) return { ran: false, failures: [] };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ninja-comparison-study-'));
  try {
    const tempFilePath = path.join(tempDir, `${label}.pdf`);
    await fs.writeFile(tempFilePath, buffer);
    return await veraPdfService.validate(tempFilePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run veraPDF against both outputs — same tool, same code path, on the
 * Ninja-remediated PDF and the operator-uploaded pdfxt PDF — and stamp
 * the trial with the current blended GPU-cost estimate.
 */
export async function validateTrial(id: string): Promise<ComparisonTrial> {
  const trial = await prisma.comparisonTrial.findUniqueOrThrow({ where: { id } });

  let ninjaPacResult: VeraPdfValidationResult = { ran: false, failures: [] };
  if (trial.ninjaJobId) {
    const job = await prisma.job.findUnique({ where: { id: trial.ninjaJobId } });
    const output = job?.output as { remediatedFileUrl?: string } | null;
    if (output?.remediatedFileUrl) {
      const buffer = await fileStorageService.downloadFile(output.remediatedFileUrl);
      ninjaPacResult = await runVeraPdf(buffer, 'ninja');
    } else {
      logger.warn(`[ComparisonStudy] Trial ${id}: Ninja job ${trial.ninjaJobId} has no remediatedFileUrl yet`);
    }
  }

  let pdfxtPacResult: VeraPdfValidationResult = { ran: false, failures: [] };
  if (trial.pdfxtS3Path) {
    const buffer = await s3Service.getFileBuffer(trial.pdfxtS3Path);
    pdfxtPacResult = await runVeraPdf(buffer, 'pdfxt');
  }

  return prisma.comparisonTrial.update({
    where: { id },
    data: {
      ninjaPacResult: ninjaPacResult as unknown as object,
      pdfxtPacResult: pdfxtPacResult as unknown as object,
      ninjaGpuCostUsd: config.ninjaGpuBlendedCostPerDocUsd,
      status: 'validated',
    },
  });
}

export interface TrialReport {
  trialId: string;
  sourceFileName: string;
  contentType: string;
  pageCount: number | null;
  ninja: {
    activeMs: number | null;
    /** Self-reported manual out-of-app time (e.g. Acrobat Pro) — invisible to activeMs. */
    manualTimeMs: number | null;
    costUsd: number | null;
    pacFailureCount: number | null;
    pagesPerHour: number | null;
  };
  pdfxt: {
    timeMs: number | null;
    costUsd: number | null;
    pacFailureCount: number | null;
    pagesPerHour: number | null;
  };
}

/**
 * Reads a persisted VeraPdfValidationResult JSON blob back out of a
 * ComparisonTrial row. Returns null (not 0) unless veraPDF genuinely ran
 * for that side of the trial — a stale row persisted before this fix
 * (a bare array, no `ran` field) also safely degrades to null rather than
 * being misread as a real failure count.
 */
function extractPacFailureCount(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = raw as { ran?: unknown; failures?: unknown };
  if (result.ran !== true || !Array.isArray(result.failures)) return null;
  return result.failures.length;
}

function pagesPerHour(pageCount: number | null, timeMs: number | null): number | null {
  if (!pageCount || !timeMs || timeMs <= 0) return null;
  return Math.round((pageCount / (timeMs / 3_600_000)) * 10) / 10;
}

/** Single-trial comparison — mirrors the KPI-tile shape of ComparisonReportPage.tsx, relabeled for pdfxt-vs-Ninja. */
export async function getTrialReport(id: string): Promise<TrialReport> {
  const trial = await prisma.comparisonTrial.findUniqueOrThrow({
    where: { id },
    include: { job: { select: { output: true } } },
  });

  const jobOutput = trial.job?.output as { aiAnalysisStats?: { totalCostUsd?: number } } | null;
  const ninjaAiCostUsd = jobOutput?.aiAnalysisStats?.totalCostUsd ?? null;
  const ninjaCostUsd =
    ninjaAiCostUsd !== null || trial.ninjaGpuCostUsd !== null
      ? (ninjaAiCostUsd ?? 0) + (trial.ninjaGpuCostUsd ?? 0)
      : null;

  const pageCount = trial.pdfxtPageCount ?? null;
  const ninjaPacFailures = extractPacFailureCount(trial.ninjaPacResult);
  const pdfxtPacFailures = extractPacFailureCount(trial.pdfxtPacResult);

  return {
    trialId: trial.id,
    sourceFileName: trial.sourceFileName,
    contentType: trial.contentType,
    pageCount,
    ninja: {
      activeMs: trial.ninjaActiveMs,
      manualTimeMs: trial.ninjaManualTimeMs,
      costUsd: ninjaCostUsd,
      pacFailureCount: ninjaPacFailures,
      pagesPerHour: pagesPerHour(pageCount, trial.ninjaActiveMs),
    },
    pdfxt: {
      timeMs: trial.pdfxtTimeMs,
      costUsd: trial.pdfxtCostUsd,
      pacFailureCount: pdfxtPacFailures,
      pagesPerHour: pagesPerHour(pageCount, trial.pdfxtTimeMs),
    },
  };
}

export interface AggregateReport {
  trialCount: number;
  validatedCount: number;
  avgNinjaActiveMs: number | null;
  avgNinjaManualTimeMs: number | null;
  avgPdfxtTimeMs: number | null;
  estimatedSpeedup: number | null;
  avgNinjaPacFailures: number | null;
  avgPdfxtPacFailures: number | null;
  avgNinjaCostUsd: number | null;
  avgPdfxtCostUsd: number | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Rolls up all validated trials — same shape as aggregate-comparison.service.ts's timeSavingsEstimate. */
export async function getAggregateReport(): Promise<AggregateReport> {
  const trials = await prisma.comparisonTrial.findMany();
  const validated = trials.filter((t) => t.status === 'validated' || t.status === 'reported');

  const reports = await Promise.all(validated.map((t) => getTrialReport(t.id)));

  const ninjaTimes = reports.map((r) => r.ninja.activeMs).filter((v): v is number => v != null);
  const ninjaManualTimes = reports.map((r) => r.ninja.manualTimeMs).filter((v): v is number => v != null);
  const pdfxtTimes = reports.map((r) => r.pdfxt.timeMs).filter((v): v is number => v != null);
  const avgNinjaActiveMs = average(ninjaTimes);
  const avgNinjaManualTimeMs = average(ninjaManualTimes);
  const avgPdfxtTimeMs = average(pdfxtTimes);

  return {
    trialCount: trials.length,
    validatedCount: validated.length,
    avgNinjaActiveMs,
    avgNinjaManualTimeMs,
    avgPdfxtTimeMs,
    estimatedSpeedup:
      avgNinjaActiveMs && avgPdfxtTimeMs ? Math.round((avgPdfxtTimeMs / avgNinjaActiveMs) * 100) / 100 : null,
    avgNinjaPacFailures: average(reports.map((r) => r.ninja.pacFailureCount).filter((v): v is number => v != null)),
    avgPdfxtPacFailures: average(reports.map((r) => r.pdfxt.pacFailureCount).filter((v): v is number => v != null)),
    avgNinjaCostUsd: average(reports.map((r) => r.ninja.costUsd).filter((v): v is number => v != null)),
    avgPdfxtCostUsd: average(reports.map((r) => r.pdfxt.costUsd).filter((v): v is number => v != null)),
  };
}

// ─── External PAC report (uploaded by an operator, NOT self-generated) ─────
//
// A real, external PAC-tool report file, distinct from BOTH of this
// codebase's other two "PAC report" concepts: pac-report.service.ts's own
// self-generated Matterhorn-protocol emulation, and this same file's own
// ninjaPacResult/pdfxtPacResult (a veraPDF failure-count blob, see
// runVeraPdf/validateTrial above). Nothing parses real PAC export files
// (HTML/XML/PDF) anywhere in this codebase, so the summary counts are
// entered manually by the uploading operator, same as pdfxtTimeMs/
// pdfxtCostUsd/etc. already are via logPdfxtData above.

const PAC_REPORT_KEY_PREFIX = 'comparison-study/pac-reports/';

/**
 * Deterministic, trial-ID-derived key -- computed the SAME way on both the
 * presign step and the confirm step below, so confirmPacReportUpload never
 * has to trust a client-supplied path (corpus.routes.ts's
 * tagged-pdf-upload-url/-confirm pair is the model for this).
 */
function buildPacReportS3Key(trialId: string, filename: string): string {
  const sanitised = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `${PAC_REPORT_KEY_PREFIX}${trialId}/${sanitised}`;
}

export interface PacReportUploadUrlResult {
  uploadUrl: string;
  expiresIn: number;
}

/** Presigned PUT URL for an operator to upload a real PAC-tool report against a trial. */
export async function getPacReportUploadUrl(
  trialId: string,
  filename: string,
  contentType: string,
): Promise<PacReportUploadUrlResult> {
  const trial = await prisma.comparisonTrial.findUnique({ where: { id: trialId } });
  if (!trial) {
    throw AppError.notFound('Trial not found');
  }

  const s3Key = buildPacReportS3Key(trialId, filename);
  const command = new PutObjectCommand({ Bucket: config.s3Bucket, Key: s3Key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, expiresIn: UPLOAD_URL_EXPIRY_SECONDS };
}

export interface PacReportSummaryInput {
  pass?: number;
  fail?: number;
  untested?: number;
  humanRequired?: number;
  notApplicable?: number;
}

/**
 * Step 2 of the upload flow: regenerate the SAME deterministic key
 * server-side (never trust a client-supplied path), then verify the object
 * actually landed via HeadObjectCommand (feedback/attachment.service.ts's
 * own confirmUpload pattern) before writing the DB row -- a client that
 * calls confirm without ever completing the S3 PUT gets a clear 400
 * instead of a row pointing at a nonexistent object.
 */
export async function confirmPacReportUpload(
  trialId: string,
  input: { originalFileName: string; mimeType: string; summary: PacReportSummaryInput; uploadedById: string },
): Promise<ExternalPacReport> {
  const trial = await prisma.comparisonTrial.findUnique({ where: { id: trialId } });
  if (!trial) {
    throw AppError.notFound('Trial not found');
  }

  const s3Key = buildPacReportS3Key(trialId, input.originalFileName);

  let size: number;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
    size = head.ContentLength ?? 0;
  } catch {
    throw AppError.badRequest('Uploaded file not found in S3 -- the upload may have failed or not completed yet');
  }

  const data = {
    s3Key,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    size,
    pass: input.summary.pass ?? null,
    fail: input.summary.fail ?? null,
    untested: input.summary.untested ?? null,
    humanRequired: input.summary.humanRequired ?? null,
    notApplicable: input.summary.notApplicable ?? null,
    uploadedById: input.uploadedById,
  };

  const report = await prisma.externalPacReport.upsert({
    where: { trialId },
    create: { trialId, ...data },
    update: data,
  });

  logger.info(`[ComparisonStudy] Confirmed external PAC report for trial ${trialId}: ${s3Key}`);
  return report;
}

/** Returns the trial's uploaded PAC report plus a presigned download URL, or null if none exists. */
export async function getPacReport(trialId: string): Promise<(ExternalPacReport & { downloadUrl: string }) | null> {
  const report = await prisma.externalPacReport.findUnique({ where: { trialId } });
  if (!report) return null;
  const { downloadUrl } = await s3Service.getPresignedDownloadUrl(report.s3Key);
  return { ...report, downloadUrl };
}

/** Removes the trial's uploaded PAC report record. Returns false (not an error) if none existed. */
export async function deletePacReport(trialId: string): Promise<boolean> {
  try {
    await prisma.externalPacReport.delete({ where: { trialId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return false;
    }
    throw err;
  }
}
