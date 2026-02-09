/**
 * Citation API Validation Schemas
 */

import { z } from 'zod';

// ============================================
// PARAMETER SCHEMAS
// ============================================

export const documentIdParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID format'),
});

export const citationIdParamSchema = z.object({
  citationId: z.string().uuid('Invalid citation ID format'),
});

export const jobIdParamSchema = z.object({
  jobId: z.string().uuid('Invalid job ID format'),
});

// ============================================
// QUERY SCHEMAS
// ============================================

export const listCitationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum([
    'PARENTHETICAL',
    'NARRATIVE',
    'FOOTNOTE',
    'ENDNOTE',
    'NUMERIC',
    'UNKNOWN'
  ]).optional(),
  style: z.enum([
    'APA',
    'MLA',
    'CHICAGO',
    'VANCOUVER',
    'HARVARD',
    'IEEE',
    'UNKNOWN'
  ]).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
  hasParsedComponent: z.coerce.boolean().optional(),
  // AC-26: Filter by review status
  needsReview: z.coerce.boolean().optional(),
});

// ============================================
// REQUEST BODY SCHEMAS
// ============================================

export const detectFromTextSchema = z.object({
  text: z.string().min(1, 'Text is required').max(500000, 'Text too long'),
  jobId: z.string().uuid().optional(),
});

// ============================================
// TYPE EXPORTS
// ============================================

export type DocumentIdParam = z.infer<typeof documentIdParamSchema>;
export type CitationIdParam = z.infer<typeof citationIdParamSchema>;
export type JobIdParam = z.infer<typeof jobIdParamSchema>;
export type ListCitationsQuery = z.infer<typeof listCitationsQuerySchema>;
export type DetectFromTextBody = z.infer<typeof detectFromTextSchema>;
