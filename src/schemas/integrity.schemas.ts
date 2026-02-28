/**
 * Integrity Check Zod Schemas
 */

import { z } from 'zod';

// ── Enums ────────────────────────────────────────────────────────

export const integrityCheckTypeEnum = z.enum([
  'FIGURE_REF',
  'TABLE_REF',
  'EQUATION_REF',
  'BOX_REF',
  'CITATION_REF',
  'SECTION_NUMBERING',
  'FIGURE_NUMBERING',
  'TABLE_NUMBERING',
  'EQUATION_NUMBERING',
  'UNIT_CONSISTENCY',
  'ABBREVIATION',
  'CROSS_REF',
  'DUPLICATE_CONTENT',
  'HEADING_HIERARCHY',
  'ALT_TEXT',
  'TABLE_STRUCTURE',
  'FOOTNOTE_REF',
  'TOC_CONSISTENCY',
  'ISBN_FORMAT',
  'DOI_FORMAT',
  'TERMINOLOGY',
]);

// ── Param Schemas ────────────────────────────────────────────────

export const jobIdParamSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
};

export const documentIdParamSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
};

export const issueIdParamSchema = {
  params: z.object({
    issueId: z.string().uuid('Invalid issue ID format'),
  }),
};

// ── Body Schemas ─────────────────────────────────────────────────

export const startCheckBodySchema = z.object({
  documentId: z.string().uuid('Invalid document ID format'),
  checkTypes: z.array(integrityCheckTypeEnum).optional(),
});

export const startCheckSchema = {
  body: startCheckBodySchema,
};

export const applyFixBodySchema = z.object({
  // no extra fields required; resolvedBy comes from auth
});

export const applyFixSchema = {
  params: z.object({
    issueId: z.string().uuid('Invalid issue ID format'),
  }),
  body: applyFixBodySchema.optional(),
};

export const ignoreIssueBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export const ignoreIssueSchema = {
  params: z.object({
    issueId: z.string().uuid('Invalid issue ID format'),
  }),
  body: ignoreIssueBodySchema.optional(),
};

export const bulkActionBodySchema = z.object({
  issueIds: z.array(z.string().uuid()).min(1, 'At least one issue ID is required').max(200),
  action: z.enum(['fix', 'ignore']),
});

export const bulkActionSchema = {
  body: bulkActionBodySchema,
};

// ── Query Schemas ────────────────────────────────────────────────

export const getIssuesQuerySchema = z.object({
  checkType: integrityCheckTypeEnum.optional(),
  severity: z.enum(['ERROR', 'WARNING', 'SUGGESTION']).optional(),
  status: z.enum(['PENDING', 'FIXED', 'IGNORED', 'WONT_FIX', 'AUTO_FIXED']).optional(),
  page: z.string().optional().transform((val) => {
    if (!val) return 1;
    const parsed = parseInt(val, 10);
    return Math.max(parsed, 1);
  }),
  limit: z.string().optional().transform((val) => {
    if (!val) return 50;
    const parsed = parseInt(val, 10);
    return Math.min(Math.max(parsed, 1), 100);
  }),
});

export const getIssuesSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
  query: getIssuesQuerySchema,
};

// ── Type Exports ─────────────────────────────────────────────────

export type StartCheckBody = z.infer<typeof startCheckBodySchema>;
export type BulkActionBody = z.infer<typeof bulkActionBodySchema>;
export type GetIssuesQuery = z.infer<typeof getIssuesQuerySchema>;
export type IgnoreIssueBody = z.infer<typeof ignoreIssueBodySchema>;
