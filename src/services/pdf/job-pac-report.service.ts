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
 */

import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { JobExternalPacReport, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';
import { AppError } from '../../utils/app-error';

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
function buildJobPacReportS3Key(jobId: string, filename: string): string {
  const sanitised = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `${JOB_PAC_REPORT_PREFIX}/${jobId}/external-pac-report/${sanitised}`;
}

export interface JobPacReportUploadUrlResult {
  uploadUrl: string;
  expiresIn: number;
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

  const s3Key = buildJobPacReportS3Key(jobId, filename);
  const command = new PutObjectCommand({ Bucket: config.s3Bucket, Key: s3Key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
  return { uploadUrl, expiresIn: UPLOAD_URL_EXPIRY_SECONDS };
}

export interface JobPacReportSummaryInput {
  pass?: number;
  fail?: number;
  untested?: number;
  humanRequired?: number;
  notApplicable?: number;
}

/**
 * Step 2 of the upload flow: regenerate the SAME deterministic key
 * server-side (never trust a client-supplied path), then verify the object
 * actually landed via HeadObjectCommand before writing the DB row -- a
 * client that calls confirm without ever completing the S3 PUT gets a
 * clear 400 instead of a row pointing at a nonexistent object. upsert (not
 * create) so a re-upload after a mistake doesn't need a manual delete first.
 */
export async function confirmJobPacReportUpload(
  jobId: string,
  input: { originalFileName: string; mimeType: string; summary: JobPacReportSummaryInput; uploadedById: string },
): Promise<JobExternalPacReport> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    throw AppError.notFound('Job not found');
  }

  const s3Key = buildJobPacReportS3Key(jobId, input.originalFileName);

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

  const report = await prisma.jobExternalPacReport.upsert({
    where: { jobId },
    create: { jobId, ...data },
    update: data,
  });

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

/** Removes the job's uploaded PAC report record. Returns false (not an error) if none existed. */
export async function deleteJobPacReport(jobId: string): Promise<boolean> {
  try {
    await prisma.jobExternalPacReport.delete({ where: { jobId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return false;
    }
    throw err;
  }
}
