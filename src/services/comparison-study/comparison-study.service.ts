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

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ComparisonTrial, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';
import { fileStorageService } from '../storage/file-storage.service';
import { veraPdfService, VeraPdfFailure } from '../pdf/verapdf.service';
import { createAndEnqueuePdfAuditJob } from '../../controllers/pdf.controller';

const COMPARISON_STUDY_PREFIX = 'comparison-study/';

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
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  return { uploadUrl, s3Key, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}

/**
 * Register a trial: point at an already-uploaded source PDF (via
 * generateUploadUrl) and kick off a normal Ninja audit job for it — the
 * SAME job-creation/enqueue path as every other PDF upload (see
 * createAndEnqueuePdfAuditJob), so the trial's Ninja side is a real job,
 * not a special case.
 */
export async function registerTrial(input: {
  sourceFileName: string;
  sourceS3Key: string;
  contentType: string;
  operatorId: string;
  tenantId: string;
  userId: string;
}): Promise<ComparisonTrial> {
  const buffer = await s3Service.getFileBuffer(input.sourceS3Key);

  const { jobId } = await createAndEnqueuePdfAuditJob(
    {
      originalname: input.sourceFileName,
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
    },
    input.tenantId,
    input.userId,
    // A trial exists to measure what Ninja's pipeline actually produces
    // against pdfxt on the same document — skipping Seam-C because the
    // source PDF's /MarkInfo /Marked flag happens to be set (which says
    // nothing about whether the existing tagging is any good) would
    // silently defeat that comparison.
    { forceAutoTag: true },
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

/** Write a buffer to a scratch temp file and run veraPDF against it — veraPDF is a CLI tool, it needs a real path. */
async function runVeraPdf(buffer: Buffer, label: string): Promise<VeraPdfFailure[]> {
  if (!veraPdfService.isAvailable()) return [];

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

  let ninjaPacResult: VeraPdfFailure[] = [];
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

  let pdfxtPacResult: VeraPdfFailure[] = [];
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
  const ninjaPacFailures = Array.isArray(trial.ninjaPacResult) ? trial.ninjaPacResult.length : null;
  const pdfxtPacFailures = Array.isArray(trial.pdfxtPacResult) ? trial.pdfxtPacResult.length : null;

  return {
    trialId: trial.id,
    sourceFileName: trial.sourceFileName,
    contentType: trial.contentType,
    pageCount,
    ninja: {
      activeMs: trial.ninjaActiveMs,
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
  const pdfxtTimes = reports.map((r) => r.pdfxt.timeMs).filter((v): v is number => v != null);
  const avgNinjaActiveMs = average(ninjaTimes);
  const avgPdfxtTimeMs = average(pdfxtTimes);

  return {
    trialCount: trials.length,
    validatedCount: validated.length,
    avgNinjaActiveMs,
    avgPdfxtTimeMs,
    estimatedSpeedup:
      avgNinjaActiveMs && avgPdfxtTimeMs ? Math.round((avgPdfxtTimeMs / avgNinjaActiveMs) * 100) / 100 : null,
    avgNinjaPacFailures: average(reports.map((r) => r.ninja.pacFailureCount).filter((v): v is number => v != null)),
    avgPdfxtPacFailures: average(reports.map((r) => r.pdfxt.pacFailureCount).filter((v): v is number => v != null)),
    avgNinjaCostUsd: average(reports.map((r) => r.ninja.costUsd).filter((v): v is number => v != null)),
    avgPdfxtCostUsd: average(reports.map((r) => r.pdfxt.costUsd).filter((v): v is number => v != null)),
  };
}
