/**
 * Citation Management Validation Schemas
 *
 * Zod schemas for validating citation management API requests.
 * Follows platform conventions from job.schemas.ts, acr.schemas.ts
 */

import { z } from 'zod';

// ============================================
// ENUMS
// ============================================

/**
 * Supported citation styles
 */
export const citationStyleEnum = z.enum([
  'APA',
  'MLA',
  'Chicago',
  'Vancouver',
  'IEEE',
  'Harvard',
  'AMA'
]);

/**
 * Reference sort options
 */
export const referenceSortByEnum = z.enum([
  'alphabetical',
  'year',
  'appearance'
]);

// ============================================
// PARAM SCHEMAS
// ============================================

/**
 * Document ID parameter validation
 */
export const documentIdParamSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  })
};

/**
 * Job ID parameter validation
 */
export const jobIdParamSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format')
  })
};

/**
 * Document ID + Reference ID parameters validation
 */
export const documentReferenceParamsSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
    referenceId: z.string().uuid('Invalid reference ID format')
  })
};

// ============================================
// BODY SCHEMAS
// ============================================

/**
 * Reorder references request body
 * Supports either:
 * - Single reference move: referenceId + newPosition
 * - Batch sort: sortBy
 */
export const reorderReferencesSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  body: z.object({
    referenceId: z.string().uuid('Invalid reference ID format').optional(),
    newPosition: z.number().int().min(1, 'Position must be at least 1').optional(),
    sortBy: referenceSortByEnum.optional()
  }).refine(
    (data) => {
      // Either have referenceId + newPosition for single move
      // OR have sortBy for batch sort
      // OR have neither (which means default behavior)
      const hasSingleMove = data.referenceId !== undefined && data.newPosition !== undefined;
      const hasBatchSort = data.sortBy !== undefined;

      // Can't have both
      if (hasSingleMove && hasBatchSort) {
        return false;
      }

      // If referenceId is provided, newPosition must also be provided
      if (data.referenceId !== undefined && data.newPosition === undefined) {
        return false;
      }

      // If newPosition is provided, referenceId must also be provided
      if (data.newPosition !== undefined && data.referenceId === undefined) {
        return false;
      }

      return true;
    },
    {
      message: 'Provide either (referenceId + newPosition) for single move, or sortBy for batch sort, but not both',
      path: ['body']
    }
  )
};

/**
 * Edit reference request body
 * All fields are optional - only provided fields are updated
 */
// Author can be either a string or an object with firstName/lastName
const authorSchema = z.union([
  z.string().min(1, 'Author name cannot be empty'),
  z.object({
    firstName: z.string().optional(),
    lastName: z.string().min(1, 'Last name is required'),
    suffix: z.string().optional()
  })
]);

export const editReferenceSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
    referenceId: z.string().uuid('Invalid reference ID format')
  }),
  body: z.object({
    authors: z.array(authorSchema)
      .min(1, 'At least one author is required')
      .optional(),
    year: z.string()
      .regex(/^\d{4}$/, 'Year must be a 4-digit number')
      .optional()
      .nullable(),
    title: z.string()
      .min(1, 'Title cannot be empty')
      .max(1000, 'Title too long (max 1000 characters)')
      .optional(),
    journalName: z.string()
      .max(500, 'Journal name too long (max 500 characters)')
      .optional()
      .nullable(),
    volume: z.string()
      .max(50, 'Volume too long (max 50 characters)')
      .optional()
      .nullable(),
    issue: z.string()
      .max(50, 'Issue too long (max 50 characters)')
      .optional()
      .nullable(),
    pages: z.string()
      .max(50, 'Pages too long (max 50 characters)')
      .optional()
      .nullable(),
    doi: z.string()
      .regex(/^10\.\d{4,}\/[^\s]+$/, 'Invalid DOI format (should start with 10.)')
      .optional()
      .nullable()
      .or(z.literal('')), // Allow empty string to clear DOI
    url: z.string()
      .url('Invalid URL format')
      .optional()
      .nullable()
      .or(z.literal('')), // Allow empty string to clear URL
    publisher: z.string()
      .max(500, 'Publisher name too long (max 500 characters)')
      .optional()
      .nullable()
  }).refine(
    (data) => {
      // At least one field should be provided
      return Object.values(data).some(v => v !== undefined);
    },
    {
      message: 'At least one field must be provided for update',
      path: ['body']
    }
  )
};

/**
 * Convert style request body
 */
export const convertStyleSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  body: z.object({
    targetStyle: citationStyleEnum.describe('Target citation style')
  })
};

/**
 * Debug style conversion request body (development only)
 */
export const debugStyleConversionSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  body: z.object({
    referenceId: z.string().uuid('Invalid reference ID format'),
    targetStyle: citationStyleEnum.describe('Target citation style for testing')
  })
};

/**
 * Upload document schema
 * Note: File validation is handled by multer, this validates metadata
 */
export const uploadDocumentSchema = {
  body: z.object({
    title: z.string().max(500, 'Title too long (max 500 characters)').optional(),
    description: z.string().max(2000, 'Description too long').optional()
  }).optional()
};

/**
 * Analysis query parameters (for filtering/pagination)
 */
export const analysisQuerySchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  query: z.object({
    includeRawCitations: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
    includeParsedReferences: z.enum(['true', 'false']).optional().transform(v => v === 'true')
  }).optional()
};

/**
 * Preview changes query parameters
 */
export const previewChangesSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  query: z.object({
    changeType: z.enum(['RENUMBER', 'REFERENCE_STYLE_CONVERSION', 'DELETE', 'INSERT', 'REFERENCE_EDIT']).optional(),
    includeReverted: z.enum(['true', 'false']).optional().transform(v => v === 'true')
  }).optional()
};

/**
 * Validate DOIs query parameters
 */
export const validateDoisSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  query: z.object({
    forceRefresh: z.enum(['true', 'false']).optional().transform(v => v === 'true')
  }).optional()
};

// ============================================
// QUERY SCHEMAS
// ============================================

/**
 * Export document query parameters
 */
export const exportDocumentSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  query: z.object({
    acceptChanges: z.string()
      .optional()
      .transform(val => val === 'true')
      .describe('If true, apply changes cleanly without Track Changes markup')
  })
};

/**
 * Dismiss specific changes by their IDs
 */
export const dismissChangesSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format')
  }),
  body: z.object({
    changeIds: z.array(z.string().uuid('Invalid change ID format'))
      .min(1, 'At least one change ID is required')
      .max(100, 'Cannot dismiss more than 100 changes at once')
  })
};

// ============================================
// TYPE EXPORTS
// ============================================

export type CitationStyle = z.infer<typeof citationStyleEnum>;
export type ReferenceSortBy = z.infer<typeof referenceSortByEnum>;
export type DocumentIdParams = z.infer<typeof documentIdParamSchema.params>;
export type JobIdParams = z.infer<typeof jobIdParamSchema.params>;
export type DocumentReferenceParams = z.infer<typeof documentReferenceParamsSchema.params>;
export type ReorderReferencesBody = z.infer<typeof reorderReferencesSchema.body>;
export type EditReferenceBody = z.infer<typeof editReferenceSchema.body>;
export type ConvertStyleBody = z.infer<typeof convertStyleSchema.body>;
export type ExportDocumentQuery = z.infer<typeof exportDocumentSchema.query>;
export type DebugStyleConversionBody = z.infer<typeof debugStyleConversionSchema.body>;
export type AnalysisQuery = z.infer<NonNullable<typeof analysisQuerySchema.query>>;
export type PreviewChangesQuery = z.infer<NonNullable<typeof previewChangesSchema.query>>;
export type ValidateDoisQuery = z.infer<NonNullable<typeof validateDoisSchema.query>>;
export type DismissChangesBody = z.infer<typeof dismissChangesSchema.body>;
