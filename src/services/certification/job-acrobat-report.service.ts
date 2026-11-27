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
 *   - every upload gets its own staging key (uploads/<uploadId>/...).
 *     Confirm reads it with a hard byte cap, then writes the exact bytes it
 *     parsed to an immutable confirmed key (confirmed/<uploadId>.html) that
 *     no upload URL ever targets -- so neither a replacement upload nor a
 *     re-PUT through a still-valid presigned URL can change confirmed
 *     evidence. The record switches only after that; the staging object
 *     and the previous confirmed object are then deleted (as on DELETE).
 *   - the report is uploaded HTML, so downloads are always signed as
 *     Content-Disposition: attachment -- never rendered inline.
 */

import { randomUUID } from 'crypto';
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { JobExternalAcrobatReport, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client } from '../s3.service';
import { AppError } from '../../utils/app-error';
import {
  parseAcrobatReport,
  MAX_ACROBAT_REPORT_BYTES,
  type AcrobatReportCounts,
  type AcrobatReportParseResult,
} from './acrobat-report-parser';
import { getCurrentRemediatedFileHash } from './remediated-file-hash';
import { revokeActiveCertification } from './certification-revoke';

const UPLOAD_URL_EXPIRY_SECONDS = 30 * 60;
const DOWNLOAD_URL_EXPIRY_SECONDS = 60 * 60;
export const ACROBAT_REPORT_CONTENT_TYPE = 'text/html';

function sanitiseFileName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
}

/**
 * Staging key for one upload. Built from server-controlled parts only --
 * jobId from the route, an uploadId the server issued (schema-validated as
 * a UUID), and the sanitised file name -- the same way at presign and at
 * confirm. Never a client-supplied path.
 */
function buildStagingKey(jobId: string, uploadId: string, filename: string): string {
  return `job-storage/${jobId}/external-acrobat-report/uploads/${uploadId}/${sanitiseFileName(filename)}`;
}

/** Where confirmed bytes live. No upload URL is ever issued under this prefix. */
function buildConfirmedKey(jobId: string, uploadId: string): string {
  return `job-storage/${jobId}/external-acrobat-report/confirmed/${uploadId}.html`;
}

/** Best effort: anything left under job-storage/<jobId>/ is swept by deleteJobFiles anyway. */
async function deleteObjectQuietly(s3Key: string, reason: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
  } catch (err) {
    logger.warn(`[JobAcrobatReport] Could not delete ${reason} ${s3Key}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  /** Pass back to confirm: identifies this upload's own staging key. */
  uploadId: string;
}

export async function getJobAcrobatReportUploadUrl(
  jobId: string,
  filename: string,
): Promise<JobAcrobatReportUploadUrlResult> {
  await assertJobExists(jobId);
  const uploadId = randomUUID();
  const s3Key = buildStagingKey(jobId, uploadId, filename);
  const command = new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: s3Key,
    ContentType: ACROBAT_REPORT_CONTENT_TYPE,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, expiresIn: UPLOAD_URL_EXPIRY_SECONDS, contentType: ACROBAT_REPORT_CONTENT_TYPE, uploadId };
}

export type OperatorAcrobatCounts = Pick<AcrobatReportCounts, 'passed' | 'failed' | 'needsManualCheck' | 'skipped'>
  & Partial<Pick<AcrobatReportCounts, 'passedManually' | 'failedManually'>>;

export interface ConfirmJobAcrobatReportInput {
  /** From the upload-url response. */
  uploadId: string;
  originalFileName: string;
  uploadedById: string;
  /** Only used when the parser can't read the report unambiguously. */
  operatorCounts?: OperatorAcrobatCounts;
}

export interface ConfirmJobAcrobatReportResult {
  report: JobExternalAcrobatReport;
  parse: AcrobatReportParseResult;
}

async function rejectTooLarge(s3Key: string, size: string): Promise<never> {
  // Never usable, so don't leave it lying around.
  await deleteObjectQuietly(s3Key, 'oversized upload');
  throw AppError.badRequest(
    `File is ${size} bytes; an Acrobat accessibility report is far smaller (limit ${MAX_ACROBAT_REPORT_BYTES}).`,
    'ACROBAT_REPORT_TOO_LARGE',
  );
}

/**
 * HEAD for a cheap early reject, then a GET read with a hard cap: the
 * object can be replaced between the two (the presigned PUT stays valid),
 * so the cap -- not the HEAD -- is what bounds memory.
 */
async function readUploadedReport(s3Key: string): Promise<Buffer> {
  let size: number;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
    size = head.ContentLength ?? 0;
  } catch {
    throw AppError.badRequest('Uploaded file not found in S3 -- the upload may have failed or not completed yet');
  }
  if (size > MAX_ACROBAT_REPORT_BYTES) return rejectTooLarge(s3Key, String(size));

  let obj;
  try {
    obj = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
  } catch {
    throw AppError.badRequest('Uploaded file not found in S3 -- the upload may have failed or not completed yet');
  }
  if (!obj.Body) throw AppError.badRequest('Uploaded file is empty');

  const body = obj.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let read = 0;
  for await (const chunk of body) {
    read += chunk.length;
    if (read > MAX_ACROBAT_REPORT_BYTES) {
      body.destroy?.();
      return rejectTooLarge(s3Key, `more than ${MAX_ACROBAT_REPORT_BYTES}`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The staging object is kept on a 422 (the operator re-confirms the same
 * uploadId with counts); the current confirmed report and its object are
 * untouched until this upload's record replaces them.
 */
export async function confirmJobAcrobatReportUpload(
  jobId: string,
  input: ConfirmJobAcrobatReportInput,
): Promise<ConfirmJobAcrobatReportResult> {
  await assertJobExists(jobId);

  const stagingKey = buildStagingKey(jobId, input.uploadId, input.originalFileName);
  const bytes = await readUploadedReport(stagingKey);
  const parse = parseAcrobatReport(bytes.toString('utf-8'));

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

  // Persist exactly the bytes that were parsed, at a key no upload URL can
  // reach. Only after this does the record point anywhere new.
  const confirmedKey = buildConfirmedKey(jobId, input.uploadId);
  await s3Client.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: confirmedKey,
    Body: bytes,
    ContentType: ACROBAT_REPORT_CONTENT_TYPE,
  }));

  const data = {
    s3Key: confirmedKey,
    originalFileName: input.originalFileName,
    mimeType: ACROBAT_REPORT_CONTENT_TYPE,
    size: bytes.length,
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

  const previous = await prisma.jobExternalAcrobatReport.findUnique({ where: { jobId }, select: { s3Key: true } });
  const report = await prisma.jobExternalAcrobatReport.upsert({
    where: { jobId },
    create: { jobId, ...data },
    update: data,
  });
  // Only once the record points at the new confirmed object do the staging
  // copy and the previous confirmed object go.
  // Replacing the evidence an active certification relies on revokes it.
  if (previous) await revokeActiveCertification(jobId, 'acrobat-report-replaced');
  await deleteObjectQuietly(stagingKey, 'staging upload');
  if (previous && previous.s3Key !== confirmedKey) {
    await deleteObjectQuietly(previous.s3Key, 'replaced report');
  }

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
  // Uploaded HTML: always a download, never rendered inline.
  const command = new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: report.s3Key,
    ResponseContentDisposition: `attachment; filename="${sanitiseFileName(report.originalFileName)}"`,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
  return { ...report, downloadUrl };
}

/** Removes the record, then its S3 object. Returns false (not an error) if none existed. */
export async function deleteJobAcrobatReport(jobId: string): Promise<boolean> {
  let deleted: JobExternalAcrobatReport;
  try {
    deleted = await prisma.jobExternalAcrobatReport.delete({ where: { jobId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
    throw err;
  }
  await revokeActiveCertification(jobId, 'acrobat-report-deleted');
  await deleteObjectQuietly(deleted.s3Key, 'deleted report');
  return true;
}
