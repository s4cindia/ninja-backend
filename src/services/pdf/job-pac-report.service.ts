/**
 * Job External PAC Report Service
 *
 * Job-native counterpart to comparison-study.service.ts's
 * getPacReportUploadUrl/confirmPacReportUpload/getPacReport/deletePacReport
 * (see JobExternalPacReport's own schema.prisma doc comment for why this is
 * a separate model/service rather than extending ExternalPacReport) --
 * lets an operator upload a real, external PAC-tool report against a
 * regular PDF Accessibility job that has no linked ComparisonTrial.
 *
 * Stored under job-storage/<jobId>/external-pac-report/ (not
 * comparison-study/pac-reports/) so fileStorageService.deleteJobFiles(jobId)
 * sweeps it up automatically, with no extra cleanup code needed.
 *
 * Staging/confirmed split (EPUB-from-certified-PDF B3b; the report is
 * certification evidence): every upload gets its own staging key
 * (uploads/<uploadId>/<name>). Confirm copies exactly the version it HEADed
 * (CopySourceIfMatch on its ETag) to an immutable confirmed key
 * (confirmed/<uploadId>.<ext>) that no upload URL ever targets, so neither
 * a replacement upload nor a re-PUT through a still-valid presigned URL can
 * change confirmed evidence. The record switches only after that; the
 * staging object and the previous confirmed object are then deleted.
 *
 * Transitional: a confirm without uploadId (a client from before the split)
 * still uses the old deterministic key, and logs a warning every time.
 * Remove once the frontend sends uploadId everywhere.
 */

import { randomUUID } from 'crypto';
import { PutObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { JobExternalPacReport, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';
import { AppError } from '../../utils/app-error';
import { getCurrentRemediatedFileHash } from '../certification/remediated-file-hash';
import { revokeActiveCertification } from '../certification/certification-revoke';

const JOB_PAC_REPORT_PREFIX = 'job-storage';
// Matches comparison-study.service.ts's own UPLOAD_URL_EXPIRY_SECONDS --
// same real-world concern (a slow-connection upload of a multi-MB PAC
// report finishing after a too-short presigned URL already expired).
const UPLOAD_URL_EXPIRY_SECONDS = 30 * 60;

/**
 * Deterministic, job-ID-derived key -- computed the SAME way on both the
 * presign step and the confirm step below, so confirmJobPacReportUpload
 * never has to trust a client-supplied path (same convention as
 * comparison-study.service.ts's buildPacReportS3Key).
 */
function sanitiseFileName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
}

/** Legacy (pre-split) key: one per file name, so a re-upload overwrites it. */
function buildJobPacReportS3Key(jobId: string, filename: string): string {
  return `${JOB_PAC_REPORT_PREFIX}/${jobId}/external-pac-report/${sanitiseFileName(filename)}`;
}

/**
 * Staging key for one upload: jobId from the route, a server-issued
 * uploadId (schema-validated UUID), the sanitised file name -- built the
 * same way at presign and at confirm, never a client-supplied path.
 */
function buildStagingKey(jobId: string, uploadId: string, filename: string): string {
  return `${JOB_PAC_REPORT_PREFIX}/${jobId}/external-pac-report/uploads/${uploadId}/${sanitiseFileName(filename)}`;
}

/** Where confirmed bytes live. No upload URL is ever issued under this prefix. */
function buildConfirmedKey(jobId: string, uploadId: string, filename: string): string {
  const ext = /\.([a-z0-9]{1,8})$/.exec(sanitiseFileName(filename))?.[1] ?? 'bin';
  return `${JOB_PAC_REPORT_PREFIX}/${jobId}/external-pac-report/confirmed/${uploadId}.${ext}`;
}

/** Best effort: anything left under job-storage/<jobId>/ is swept by deleteJobFiles anyway. */
async function deleteObjectQuietly(s3Key: string, reason: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: s3Key }));
  } catch (err) {
    logger.warn(`[JobPacReport] Could not delete ${reason} ${s3Key}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!e && (e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412);
}

export interface JobPacReportUploadUrlResult {
  uploadUrl: string;
  expiresIn: number;
  /** Pass back to confirm: identifies this upload's own staging key. */
  uploadId: string;
}

/** Presigned PUT URL for an operator to upload a real PAC-tool report against a job. */
export async function getJobPacReportUploadUrl(
  jobId: string,
  filename: string,
  contentType: string,
): Promise<JobPacReportUploadUrlResult> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw AppError.notFound('Job not found');
  }

  const uploadId = randomUUID();
  const s3Key = buildStagingKey(jobId, uploadId, filename);
  const command = new PutObjectCommand({ Bucket: config.s3Bucket, Key: s3Key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, expiresIn: UPLOAD_URL_EXPIRY_SECONDS, uploadId };
}

export interface JobPacReportSummaryInput {
  pass?: number;
  fail?: number;
  untested?: number;
  humanRequired?: number;
  notApplicable?: number;
}

export interface ConfirmJobPacReportInput {
  /** From the upload-url response. Optional only during the transition (see file comment). */
  uploadId?: string;
  originalFileName: string;
  mimeType: string;
  summary: JobPacReportSummaryInput;
  uploadedById: string;
}

/**
 * Step 2 of the upload flow: rebuild the key server-side (never trust a
 * client-supplied path), then verify the object actually landed via
 * HeadObjectCommand before writing the DB row -- a client that calls
 * confirm without ever completing the S3 PUT gets a clear 400 instead of a
 * row pointing at a nonexistent object. With an uploadId, the staged
 * version is then copied to its immutable confirmed key (see file comment).
 * upsert (not create) so a re-upload after a mistake doesn't need a manual
 * delete first.
 */
export async function confirmJobPacReportUpload(
  jobId: string,
  input: ConfirmJobPacReportInput,
): Promise<JobExternalPacReport> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw AppError.notFound('Job not found');
  }

  const stagingKey = input.uploadId
    ? buildStagingKey(jobId, input.uploadId, input.originalFileName)
    : buildJobPacReportS3Key(jobId, input.originalFileName);
  if (!input.uploadId) {
    logger.warn(
      `[JobPacReport] Legacy confirm without uploadId for job ${jobId} -- using the overwritable ` +
        `deterministic key ${stagingKey}. Update the client to send uploadId.`,
    );
  }

  let size: number;
  let etag: string | undefined;
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: stagingKey }));
    size = head.ContentLength ?? 0;
    etag = head.ETag;
  } catch {
    throw AppError.badRequest('Uploaded file not found in S3 -- the upload may have failed or not completed yet');
  }

  let s3Key = stagingKey;
  if (input.uploadId) {
    s3Key = buildConfirmedKey(jobId, input.uploadId, input.originalFileName);
    try {
      await s3Client.send(new CopyObjectCommand({
        Bucket: config.s3Bucket,
        Key: s3Key,
        CopySource: `${config.s3Bucket}/${stagingKey}`,
        // Copy exactly the version whose size was just recorded.
        ...(etag ? { CopySourceIfMatch: etag } : {}),
      }));
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw AppError.conflict('The uploaded file changed while it was being confirmed -- confirm again', 'PAC_REPORT_UPLOAD_CHANGED');
      }
      throw err;
    }
  }

  // Bind the report to the exact remediated PDF it was run on (EPUB-from-
  // certified-PDF gate). Null when the job has no remediated file yet.
  const remediated = await getCurrentRemediatedFileHash(jobId);

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
    remediatedSha256: remediated?.sha256 ?? null,
  };

  const previous = await prisma.jobExternalPacReport.findUnique({ where: { jobId }, select: { id: true, s3Key: true } });
  const report = await prisma.jobExternalPacReport.upsert({
    where: { jobId },
    create: { jobId, ...data },
    update: data,
  });
  // Replacing the evidence an active EPUB-from-PDF certification relies on revokes it.
  if (previous) await revokeActiveCertification(jobId, 'pac-report-replaced');
  // Only once the record points at the confirmed copy do the staging object
  // and the previous confirmed object go.
  if (input.uploadId) await deleteObjectQuietly(stagingKey, 'staging upload');
  if (previous?.s3Key && previous.s3Key !== s3Key) {
    await deleteObjectQuietly(previous.s3Key, 'replaced report');
  }

  logger.info(`[JobPacReport] Confirmed external PAC report for job ${jobId}: ${s3Key}`);
  return report;
}

/** Returns the job's uploaded PAC report plus a presigned download URL, or null if none exists. */
export async function getJobPacReport(jobId: string): Promise<(JobExternalPacReport & { downloadUrl: string }) | null> {
  const report = await prisma.jobExternalPacReport.findUnique({ where: { jobId } });
  if (!report) return null;
  const { downloadUrl } = await s3Service.getPresignedDownloadUrl(report.s3Key);
  return { ...report, downloadUrl };
}

/**
 * Removes the job's uploaded PAC report record, then its S3 object.
 * Returns false (not an error) if none existed.
 */
export async function deleteJobPacReport(jobId: string): Promise<boolean> {
  let deleted: { s3Key?: string | null };
  try {
    deleted = await prisma.jobExternalPacReport.delete({ where: { jobId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return false;
    }
    throw err;
  }
  await revokeActiveCertification(jobId, 'pac-report-deleted');
  if (deleted?.s3Key) await deleteObjectQuietly(deleted.s3Key, 'deleted report');
  return true;
}
