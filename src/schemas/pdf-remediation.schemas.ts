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
    jobId: z.string().min(1, 'Job ID is required'),
  }),
};

/**
 * Schema for getting a remediation plan
 * GET /api/v1/pdf/:jobId/remediation/plan
 */
export const getRemediationPlanSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
};

/**
 * Schema for updating task status
 * PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId
 */
export const updateTaskStatusSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
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
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  query: z.object({
    type: fixTypeSchema.optional(),
    status: taskStatusSchema.optional(),
  }),
};

/**
 * Schema for executing auto-remediation
 * POST /api/v1/pdf/:jobId/remediation/execute
 */
export const executeAutoRemediationSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
};

/**
 * Schema for quick-fix request
 * POST /api/v1/pdf/:jobId/remediation/quick-fix/:issueId
 */
export const quickFixRequestSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
    issueId: z.string().min(1, 'Issue ID is required'),
  }),
  body: z.object({
    // Field being fixed (language, title, metadata, creator)
    field: z.enum(['language', 'title', 'metadata', 'creator']),
    // New value (not required for metadata which is boolean)
    value: z.string().optional(),
  }),
};

/**
 * Schema for preview request
 * GET /api/v1/pdf/:jobId/remediation/preview/:issueId
 */
export const previewFixSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
    issueId: z.string().min(1, 'Issue ID is required'),
  }),
  query: z.object({
    field: z.enum(['language', 'title', 'metadata', 'creator']),
    value: z.string().optional(),
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
export type QuickFixRequestParams = z.infer<typeof quickFixRequestSchema['params']>;
export type QuickFixRequestBody = z.infer<typeof quickFixRequestSchema['body']>;
export type PreviewFixParams = z.infer<typeof previewFixSchema['params']>;
export type PreviewFixQuery = z.infer<typeof previewFixSchema['query']>;
