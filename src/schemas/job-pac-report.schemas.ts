/**
 * Job External PAC Report Validation Schemas
 *
 * Zod schemas for the job-native external-PAC-report-upload endpoints
 * (upload-url / confirm), mirroring comparison-study.routes.ts's
 * pacReportUploadUrlBodySchema/pacReportConfirmBodySchema field-for-field --
 * same shape, just reachable by any job owner instead of admin-only.
 */

import { z } from 'zod';

export const jobPacReportUploadUrlSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    filename: z.string().min(1),
    contentType: z.string().default('application/pdf'),
  }),
};

export const jobPacReportConfirmSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    originalFileName: z.string().min(1),
    mimeType: z.string().min(1),
    summary: z
      .object({
        pass: z.number().int().nonnegative().optional(),
        fail: z.number().int().nonnegative().optional(),
        untested: z.number().int().nonnegative().optional(),
        humanRequired: z.number().int().nonnegative().optional(),
        notApplicable: z.number().int().nonnegative().optional(),
      })
      .default({}),
  }),
};

export type JobPacReportUploadUrlBody = z.infer<typeof jobPacReportUploadUrlSchema['body']>;
export type JobPacReportConfirmBody = z.infer<typeof jobPacReportConfirmSchema['body']>;
