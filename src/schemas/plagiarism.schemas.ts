/**
 * Plagiarism Check Zod Schemas
 */

import { z } from 'zod';

// -- Enums --

export const plagiarismMatchTypeEnum = z.enum([
  'INTERNAL',
  'SELF_PLAGIARISM',
  'EXTERNAL_WEB',
  'EXTERNAL_ACADEMIC',
  'EXTERNAL_PUBLISHER',
]);

export const plagiarismClassificationEnum = z.enum([
  'VERBATIM_COPY',
  'PARAPHRASED',
  'COMMON_PHRASE',
  'PROPERLY_CITED',
  'COINCIDENTAL',
  'NEEDS_REVIEW',
]);

export const matchReviewStatusEnum = z.enum([
  'PENDING',
  'CONFIRMED_PLAGIARISM',
  'FALSE_POSITIVE',
  'PROPERLY_ATTRIBUTED',
  'DISMISSED',
]);

// -- Param Schemas --

export const plagiarismJobIdParamSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
};

export const plagiarismDocumentIdParamSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
};

export const plagiarismMatchIdParamSchema = {
  params: z.object({
    matchId: z.string().uuid('Invalid match ID format'),
  }),
};

// -- Body Schemas --

export const startPlagiarismCheckBodySchema = z.object({
  documentId: z.string().uuid('Invalid document ID format'),
});

export const startPlagiarismCheckSchema = {
  body: startPlagiarismCheckBodySchema,
};

export const reviewMatchBodySchema = z.object({
  status: z.enum(['CONFIRMED_PLAGIARISM', 'FALSE_POSITIVE', 'PROPERLY_ATTRIBUTED', 'DISMISSED']),
  reviewNotes: z.string().max(1000).optional(),
});

export const reviewMatchSchema = {
  params: z.object({
    matchId: z.string().uuid('Invalid match ID format'),
  }),
  body: reviewMatchBodySchema,
};

export const bulkReviewBodySchema = z.object({
  matchIds: z.array(z.string().uuid()).min(1, 'At least one match ID is required').max(200),
  status: z.enum(['CONFIRMED_PLAGIARISM', 'FALSE_POSITIVE', 'PROPERLY_ATTRIBUTED', 'DISMISSED']),
});

export const bulkReviewSchema = {
  body: bulkReviewBodySchema,
};

// -- Query Schemas --

export const getMatchesQuerySchema = z.object({
  matchType: plagiarismMatchTypeEnum.optional(),
  classification: plagiarismClassificationEnum.optional(),
  status: matchReviewStatusEnum.optional(),
  page: z.string().optional().transform((val) => {
    if (!val) return 1;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? 1 : Math.max(parsed, 1);
  }),
  limit: z.string().optional().transform((val) => {
    if (!val) return 50;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? 50 : Math.min(Math.max(parsed, 1), 100);
  }),
});

export const getMatchesSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
  query: getMatchesQuerySchema,
};

// -- Type Exports --

export type StartPlagiarismCheckBody = z.infer<typeof startPlagiarismCheckBodySchema>;
export type ReviewMatchBody = z.infer<typeof reviewMatchBodySchema>;
export type BulkReviewBody = z.infer<typeof bulkReviewBodySchema>;
export type GetMatchesQuery = z.infer<typeof getMatchesQuerySchema>;
