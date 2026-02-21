import { z } from 'zod';

/**
 * Validator API Schemas
 * Zod validation schemas for the Validator API endpoints
 */

// Query schema for listDocuments
export const listDocumentsQuerySchema = z.object({
  limit: z.string().optional().transform((val) => {
    if (!val) return 50;
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) return 50;
    return Math.min(Math.max(parsed, 1), 100);
  }),
  offset: z.string().optional().transform((val) => {
    if (!val) return 0;
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) return 0;
    return Math.max(parsed, 0);
  }),
});

// Params schema for getDocument
export const getDocumentParamsSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
});

// Type exports
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type GetDocumentParams = z.infer<typeof getDocumentParamsSchema>;
