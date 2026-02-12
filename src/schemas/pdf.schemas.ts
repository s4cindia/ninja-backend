/**
 * PDF Controller Validation Schemas
 *
 * Zod schemas for request validation
 */

import { z } from 'zod';

/**
 * Scan level enum schema
 */
export const scanLevelSchema = z.enum(['basic', 'comprehensive', 'custom']);

/**
 * Validator type enum schema
 */
export const validatorTypeSchema = z.enum([
  'structure',
  'alt-text',
  'contrast',
  'tables',
  'headings',
  'reading-order',
  'lists',
  'language',
  'metadata',
]);

/**
 * Schema for re-scanning a PDF job
 * POST /api/v1/pdf/:jobId/rescan
 */
export const reScanJobSchema = {
  params: z.object({
    jobId: z.string().min(1, 'Job ID is required'),
  }),
  body: z.object({
    scanLevel: scanLevelSchema.default('comprehensive'),
    customValidators: z.array(validatorTypeSchema).optional(),
  }),
};

/**
 * Type exports for use in controllers
 */
export type ScanLevel = z.infer<typeof scanLevelSchema>;
export type ReScanJobParams = z.infer<typeof reScanJobSchema['params']>;
export type ReScanJobBody = z.infer<typeof reScanJobSchema['body']>;
