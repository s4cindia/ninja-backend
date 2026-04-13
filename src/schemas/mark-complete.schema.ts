import { z } from 'zod';

export const runIssueCategoryEnum = z.enum([
  'PAGE_ALIGNMENT_MISMATCH',
  'INSUFFICIENT_JOINT_COVERAGE',
  'LIMITED_ZONE_COVERAGE',
  'UNEQUAL_EXTRACTOR_COVERAGE',
  'SINGLE_EXTRACTOR_ONLY',
  'ZONE_CONTENT_DIVERGENCE',
  'COMPLETED_WITH_REDUCED_SCOPE',
  'OTHER',
]);

export const markCompleteIssueSchema = z
  .object({
    category: runIssueCategoryEnum,
    pagesAffected: z.number().int().min(0).nullable().optional(),
    description: z.string().max(1000).optional().default(''),
    blocking: z.boolean().optional().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.category === 'OTHER' && (!val.description || val.description.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message: 'description is required when category is OTHER',
      });
    }
  });

// NOTE: intentionally NOT `.strict()`. This endpoint previously ignored the
// request body entirely, so older clients may still post legacy keys alongside
// the new payload. We drop unknown keys silently to preserve wire-level
// backward compatibility.
export const markCompleteBodySchema = z.object({
  // Allow 0 so callers can record runs that were marked complete before any
  // page could be reviewed (reduced-scope / blocked completions).
  pagesReviewed: z.number().int().min(0).optional(),
  issues: z.array(markCompleteIssueSchema).optional(),
  notes: z.string().max(2000).optional(),
});

export type MarkCompleteBody = z.infer<typeof markCompleteBodySchema>;
