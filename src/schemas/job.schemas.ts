import { z } from 'zod';
import { paginationSchema } from './common.schemas';

export const jobTypeEnum = z.enum([
  'ACCESSIBILITY_SCAN',
  'VPAT_GENERATION',
  'ACR_GENERATION',
  'REMEDIATION'
]);

export const jobStatusEnum = z.enum([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

export const jobPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const createJobSchema = z.object({
  type: jobTypeEnum,
  productId: z.string().uuid('Invalid product ID'),
  fileId: z.string().uuid('Invalid file ID').optional(),
  priority: jobPriorityEnum.default('NORMAL'),
  options: z.record(z.string(), z.unknown()).optional()
});

export const listJobsSchema = z.object({
  ...paginationSchema.shape,
  status: jobStatusEnum.optional(),
  type: jobTypeEnum.optional()
});

export type JobType = z.infer<typeof jobTypeEnum>;
export type JobStatus = z.infer<typeof jobStatusEnum>;
export type JobPriority = z.infer<typeof jobPriorityEnum>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ListJobsQuery = z.infer<typeof listJobsSchema>;
