/**
 * PDF Remediation Validation Schemas
 *
 * Zod schemas for request validation
 */

import { z } from 'zod';

/**
 * Task status enum schema
 */
export const taskStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
]);

/**
 * Fix type enum schema
 */
export const fixTypeSchema = z.enum([
  'AUTO_FIXABLE',
  'QUICK_FIX',
  'MANUAL',
]);

/**
 * Schema for creating a remediation plan
 * POST /api/v1/pdf/:jobId/remediation/plan
 */
export const createRemediationPlanSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
};

/**
 * Schema for getting a remediation plan
 * GET /api/v1/pdf/:jobId/remediation/plan
 */
export const getRemediationPlanSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
};

/**
 * Schema for updating task status
 * PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId
 */
export const updateTaskStatusSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
    taskId: z.string().min(1, 'Task ID is required'),
  }),
  body: z.object({
    status: taskStatusSchema,
    errorMessage: z.string().optional(),
    notes: z.string().optional(),
  }),
};

/**
 * Schema for filtering tasks by type
 * GET /api/v1/pdf/:jobId/remediation/tasks?type=AUTO_FIXABLE
 */
export const filterTasksSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
  query: z.object({
    type: fixTypeSchema.optional(),
    status: taskStatusSchema.optional(),
  }),
};

/**
 * Type exports for use in controllers
 */
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type FixType = z.infer<typeof fixTypeSchema>;
export type CreateRemediationPlanParams = z.infer<typeof createRemediationPlanSchema['params']>;
export type GetRemediationPlanParams = z.infer<typeof getRemediationPlanSchema['params']>;
export type UpdateTaskStatusParams = z.infer<typeof updateTaskStatusSchema['params']>;
export type UpdateTaskStatusBody = z.infer<typeof updateTaskStatusSchema['body']>;
export type FilterTasksQuery = z.infer<typeof filterTasksSchema['query']>;
