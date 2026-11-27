/**
 * Job External Acrobat Report Service
 *
 * Upload flow for the Acrobat Pro Accessibility Checker HTML report, the
 * second piece of evidence (with the PAC report) for the EPUB-from-
 * certified-PDF certification gate. Mirrors job-pac-report.service.ts:
 * presigned PUT, then confirm, under job-storage/<jobId>/... so
 * fileStorageService.deleteJobFiles(jobId) sweeps it up.
 *
 * Differences from the PAC flow:
 *   - confirm reads the uploaded HTML back and parses it server-side
 *     (acrobat-report-parser.ts). Parsed counts are used whenever the parser
 *     trusts them; otherwise the operator must supply counts, and a confirm
 *     without them is refused with 422 + the parse result (so the UI can
 *     pre-fill the form) and nothing is saved.
 *   - the report is bound to the remediated PDF it was run on via
 *     remediatedSha256, computed at confirm time.
 */

import { PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { JobExternalAcrobatReport, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';
import { AppError } from '../../utils/app-error';
import {
  parseAcrobatReport,
  MAX_ACROBAT_REPORT_BYTES,
  type AcrobatReportCounts,
  type AcrobatReportParseResult,
} from './acrobat-report-parser';
import { getCurrentRemediatedFileHash } from './remediated-file-hash';

const UPLOAD_URL_EXPIRY_SECONDS = 30 * 60;
export const ACROBAT_REPORT_CONTENT_TYPE = 'text/html';

function buildJobAcrobatReportS3Key(jobId: string, filename: string): string {
  const sanitised = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `job-storage/${jobId}/external-acrobat-report/${sanitised}`;
}

async function assertJobExists(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) throw AppError.notFound('Job not found');
}

export interface JobAcrobatReportUploadUrlResult {
  uploadUrl: string;
  expiresIn: number;
  /** The client must PUT with exactly this Content-Type (it is signed). */
  contentType: string;
}

export async function getJobAcrobatReportUploadUrl(
  jobId: string,
  filename: string,
): Promise<JobAcrobatReportUploadUrlResult> {
  await assertJobExists(jobId);
  const s3Key = buildJobAcrobatReportS3Key(jobId, filename);
  const command = new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: s3Key,
    ContentType: ACROBAT_REPORT_CONTENT_TYPE,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, expiresIn: UPLOAD_URL_EXPIRY_SECONDS, contentType: ACROBAT_REPORT_CONTENT_TYPE };
}

export type OperatorAcrobatCounts = Pick<AcrobatReportCounts, 'passed' | 'failed' | 'needsManualCheck' | 'skipped'>
  & Partial<Pick<AcrobatReportCounts, 'passedManually' | 'failedManually'>>;

export interface ConfirmJobAcrobatReportInput {
  originalFileName: string;
  uploadedById: string;
  /** Only used when the parser can't read the report unambiguously. */
  operatorCounts?: OperatorAcrobatCounts;
}

export interface ConfirmJobAcrobatReportResult {
  report: JobExternalAcrobatReport;
  parse: AcrobatReportParseResult;
}

async function readUploadedReport(s3Key: string): Promise<string> {
  let size: number;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
    size = head.ContentLength ?? 0;
  } catch {
    throw AppError.badRequest('Uploaded file not found in S3 -- the upload may have failed or not completed yet');
  }
  if (size > MAX_ACROBAT_REPORT_BYTES) {
    throw AppError.badRequest(
      `File is ${size} bytes; an Acrobat accessibility report is far smaller (limit ${MAX_ACROBAT_REPORT_BYTES}).`,
      'ACROBAT_REPORT_TOO_LARGE',
    );
  }

  const obj = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
  if (!obj.Body) throw AppError.badRequest('Uploaded file is empty');
  return obj.Body.transformToString('utf-8');
}

export async function confirmJobAcrobatReportUpload(
  jobId: string,
  input: ConfirmJobAcrobatReportInput,
): Promise<ConfirmJobAcrobatReportResult> {
  await assertJobExists(jobId);

  const s3Key = buildJobAcrobatReportS3Key(jobId, input.originalFileName);
  const html = await readUploadedReport(s3Key);
  const parse = parseAcrobatReport(html);

  let counts: OperatorAcrobatCounts;
  let countsSource: 'parsed' | 'operator';
  if (parse.trusted && parse.counts) {
    counts = parse.counts;
    countsSource = 'parsed';
  } else if (input.operatorCounts) {
    counts = input.operatorCounts;
    countsSource = 'operator';
  } else {
    throw new AppError(
      'The report could not be read unambiguously; enter its summary counts.',
      422,
      'ACROBAT_REPORT_COUNTS_REQUIRED',
      { parse },
    );
  }

  const remediated = await getCurrentRemediatedFileHash(jobId);

  const data = {
    s3Key,
    originalFileName: input.originalFileName,
    mimeType: ACROBAT_REPORT_CONTENT_TYPE,
    size: Buffer.byteLength(html, 'utf8'),
    passed: counts.passed,
    failed: counts.failed,
    needsManualCheck: counts.needsManualCheck,
    skipped: counts.skipped,
    passedManually: counts.passedManually ?? null,
    failedManually: counts.failedManually ?? null,
    countsSource,
    failedRules: parse.failedRules as unknown as Prisma.InputJsonValue,
    parseWarnings: parse.warnings as unknown as Prisma.InputJsonValue,
    remediatedSha256: remediated?.sha256 ?? null,
    uploadedById: input.uploadedById,
  };

  const report = await prisma.jobExternalAcrobatReport.upsert({
    where: { jobId },
    create: { jobId, ...data },
    update: data,
  });

  logger.info(
    `[JobAcrobatReport] Confirmed Acrobat report for job ${jobId}: failed=${counts.failed} source=${countsSource}` +
      (remediated ? '' : ' (no remediated file yet)'),
  );
  return { report, parse };
}

export async function getJobAcrobatReport(
  jobId: string,
): Promise<(JobExternalAcrobatReport & { downloadUrl: string }) | null> {
  const report = await prisma.jobExternalAcrobatReport.findUnique({ where: { jobId } });
  if (!report) return null;
  const { downloadUrl } = await s3Service.getPresignedDownloadUrl(report.s3Key);
  return { ...report, downloadUrl };
}

/** Returns false (not an error) if none existed. */
export async function deleteJobAcrobatReport(jobId: string): Promise<boolean> {
  try {
    await prisma.jobExternalAcrobatReport.delete({ where: { jobId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
    throw err;
  }
}
