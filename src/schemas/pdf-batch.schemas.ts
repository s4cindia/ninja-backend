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
