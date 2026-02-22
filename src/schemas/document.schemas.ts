import { z } from 'zod';

// ============================================
// Document Version Schemas
// ============================================

export const createVersionSchema = z.object({
  reason: z.string().optional(),
  snapshot: z.object({
    documentId: z.string().uuid('Invalid document ID'),
    content: z.string(),
    metadata: z.object({
      wordCount: z.number().int().min(0),
      pageCount: z.number().int().min(0).optional(),
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      language: z.string().optional(),
    }),
    references: z.array(z.object({
      id: z.string(),
      rawText: z.string(),
      refNumber: z.number().int().optional(),
    })).optional(),
    citations: z.array(z.object({
      id: z.string(),
      rawText: z.string(),
      referenceId: z.string().optional(),
    })).optional(),
  }).optional(),
});

export const compareVersionsQuerySchema = z.object({
  versionA: z.coerce.number().int().min(1, 'versionA must be a positive integer'),
  versionB: z.coerce.number().int().min(1, 'versionB must be a positive integer'),
});

export const versionParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
  version: z.coerce.number().int().min(1, 'version must be a positive integer'),
});

// ============================================
// Track Changes Schemas
// ============================================

export const documentChangeTypeEnum = z.enum([
  'INSERT',
  'DELETE',
  'FORMAT',
  'REPLACE',
  'STYLE_FIX',
  'COMPLIANCE_FIX',
]);

export const createChangeSchema = z.object({
  changeType: documentChangeTypeEnum,
  startOffset: z.number().int().min(0, 'startOffset must be non-negative'),
  endOffset: z.number().int().min(0, 'endOffset must be non-negative'),
  beforeText: z.string().optional(),
  afterText: z.string().optional(),
  reason: z.string().optional(),
  sourceType: z.enum(['auto', 'manual', 'ai_suggestion']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((data) => data.endOffset >= data.startOffset, {
  message: 'endOffset must be greater than or equal to startOffset',
  path: ['endOffset'],
});

export const bulkActionSchema = z.object({
  action: z.enum(['accept', 'reject']),
  changeIds: z.array(z.string().uuid('Invalid change ID'))
    .min(1, 'At least one changeId is required')
    .max(500, 'Cannot process more than 500 changes at once'),
});

export const changesQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_APPLIED']).optional(),
  limit: z.string().optional().transform((val) => {
    if (!val) return 100;
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) return 100;
    // Cap at 100 to limit payload size (beforeText/afterText can be large)
    return Math.min(Math.max(parsed, 1), 100);
  }),
  offset: z.string().optional().transform((val) => {
    if (!val) return 0;
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) return 0;
    return Math.max(parsed, 0);
  }),
});

export const versionsQuerySchema = z.object({
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

// ============================================
// Type Exports
// ============================================

export type CreateVersionInput = z.infer<typeof createVersionSchema>;
export type CompareVersionsQuery = z.infer<typeof compareVersionsQuerySchema>;
export type CreateChangeInput = z.infer<typeof createChangeSchema>;
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
export type ChangesQuery = z.infer<typeof changesQuerySchema>;
export type VersionsQuery = z.infer<typeof versionsQuerySchema>;
