import { z } from 'zod';

// AnnotationStatus union for the Status Tracker tab.
// JUST_STARTED was dropped during sizing — IN_PROGRESS with low pagesAnnotated
// covers the same operational signal. NOT_STARTED, IN_PROGRESS, and COMPLETED
// are reachable via derivation; PENDING_REVIEW and BLOCKED are override-only.
export const ANNOTATION_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'COMPLETED',
  'BLOCKED',
] as const;

export const annotationStatusSchema = z.enum(ANNOTATION_STATUSES);
export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;

// PUT /api/v1/admin/corpus/documents/:documentId/status body.
// Either field may be provided; both are optional but at least one should be
// present for the request to be meaningful. statusOverride === null clears
// the override and reverts the row to its derived status.
export const updateCorpusStatusSchema = z
  .object({
    statusOverride: annotationStatusSchema.nullable().optional(),
    statusNote: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) => data.statusOverride !== undefined || data.statusNote !== undefined,
    { message: 'Provide statusOverride and/or statusNote' },
  );

export type UpdateCorpusStatusInput = z.infer<typeof updateCorpusStatusSchema>;

export const documentIdParamSchema = z.string().min(1);
