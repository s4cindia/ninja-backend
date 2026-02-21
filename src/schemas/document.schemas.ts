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
  versionA: z.string().transform((val) => {
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
      throw new Error('versionA must be a positive integer');
    }
    return num;
  }),
  versionB: z.string().transform((val) => {
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
      throw new Error('versionB must be a positive integer');
    }
    return num;
  }),
});

export const versionParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
  version: z.string().transform((val) => {
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
      throw new Error('version must be a positive integer');
    }
    return num;
  }),
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
  sourceType: z.enum(['auto', 'manual', 'ai_suggestion', 'onlyoffice']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((data) => data.endOffset >= data.startOffset, {
  message: 'endOffset must be greater than or equal to startOffset',
  path: ['endOffset'],
});

export const bulkActionSchema = z.object({
  action: z.enum(['accept', 'reject']),
  changeIds: z.array(z.string().uuid('Invalid change ID')).min(1, 'At least one changeId is required'),
});

export const changesQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_APPLIED']).optional(),
  limit: z.string().transform((val) => Math.min(parseInt(val, 10) || 100, 500)).optional(),
  offset: z.string().transform((val) => parseInt(val, 10) || 0).optional(),
});

export const versionsQuerySchema = z.object({
  limit: z.string().transform((val) => Math.min(parseInt(val, 10) || 50, 100)).optional(),
  offset: z.string().transform((val) => parseInt(val, 10) || 0).optional(),
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
