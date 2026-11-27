/**
 * Job External Acrobat Report Validation Schemas
 *
 * Upload-url / confirm bodies for the Acrobat Pro accessibility report
 * endpoints (acrobat-report.routes.ts). No contentType in the upload-url
 * body: the report is always signed as text/html.
 */

import { z } from 'zod';

const count = z.number().int().nonnegative();

export const jobAcrobatReportUploadUrlSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    filename: z.string().min(1).max(255).regex(/\.html?$/i, 'Acrobat accessibility reports are .html files'),
  }),
};

export const jobAcrobatReportConfirmSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    // Returned by upload-url; selects this upload's own staging key.
    uploadId: z.string().uuid('uploadId must be the value returned by upload-url'),
    originalFileName: z.string().min(1).max(255).regex(/\.html?$/i, 'Acrobat accessibility reports are .html files'),
    // Required only when the server can't parse the report unambiguously
    // (it answers 422 ACROBAT_REPORT_COUNTS_REQUIRED in that case).
    operatorCounts: z
      .object({
        passed: count,
        failed: count,
        needsManualCheck: count,
        skipped: count,
        passedManually: count.optional(),
        failedManually: count.optional(),
      })
      .optional(),
  }),
};

export type JobAcrobatReportUploadUrlBody = z.infer<typeof jobAcrobatReportUploadUrlSchema['body']>;
export type JobAcrobatReportConfirmBody = z.infer<typeof jobAcrobatReportConfirmSchema['body']>;
