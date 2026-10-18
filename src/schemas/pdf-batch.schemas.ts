import { z } from 'zod';

export const pdfBatchCreateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export const pdfBatchAddItemsSchema = z.object({
  items: z.array(
    z.object({
      sourceFileId: z.string().min(1),
    })
  ).min(1).max(50),
});

export const pdfBatchListSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(['DRAFT', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
});

/**
 * Optional per-batch Auto Mode overrides for POST /pdf-batches/:batchId/start
 * -- applied uniformly to every item's own PdfAutoRemediationRun (each item
 * still gets its own independent budget/round count, not a shared pool
 * across the batch). Bounds and shape are identical to the single-file
 * job-native endpoint's own schema (pdf-auto-mode.schemas.ts's
 * startAutoModeSchema.body) -- reused deliberately, not just coincidentally
 * similar: this endpoint is reachable by any authenticated tenant user on
 * their own batch, the same reasoning that endpoint's own doc comment gives
 * for being tighter than the admin-only trial config schema.
 */
export const pdfBatchStartSchema = z.object({
  autoMaxRounds: z.number().int().min(1).max(20).optional(),
  autoCostLimitUsd: z.number().min(0.1).max(10).optional(),
  autoColorContrastMode: z.enum(['guidance-only', 'disabled', 'apply-to-pdf']).optional(),
}).strict().optional();

export type PdfBatchStartBody = z.infer<typeof pdfBatchStartSchema>;
