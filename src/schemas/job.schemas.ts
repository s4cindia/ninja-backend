import { z } from 'zod';
import { paginationSchema } from './common.schemas';

export const jobTypeEnum = z.enum([
  'PDF_ACCESSIBILITY',
  'EPUB_ACCESSIBILITY',
  'VPAT_GENERATION',
  'ALT_TEXT_GENERATION',
  'METADATA_EXTRACTION',
  'BATCH_VALIDATION',
  'ACR_WORKFLOW'
]);

export const jobStatusEnum = z.enum([
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

export const createJobSchema = {
  body: z.object({
    type: jobTypeEnum,
    productId: z.string().uuid('Invalid product ID').optional(),
    fileId: z.string().uuid('Invalid file ID').optional(),
    priority: z.number().int().min(0).max(10).default(0),
    options: z.record(z.string(), z.unknown()).optional()
  })
};

export const listJobsSchema = {
  query: z.object({
    ...paginationSchema.shape,
    status: jobStatusEnum.optional(),
    type: jobTypeEnum.optional()
  })
};

export type JobType = z.infer<typeof jobTypeEnum>;
export type JobStatus = z.infer<typeof jobStatusEnum>;
export type CreateJobInput = z.infer<typeof createJobSchema.body>;
export type ListJobsQuery = z.infer<typeof listJobsSchema.query>;
