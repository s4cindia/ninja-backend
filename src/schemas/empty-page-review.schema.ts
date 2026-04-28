import { z } from 'zod';

// Mirrors the PAGE_TYPES constant in
// ninja-frontend/docs/empty-pages-review/sheet-setup.gs.
// Keep verbatim — the frontend dropdown enforces the same list.
export const EMPTY_PAGE_TYPES = [
  'blank',
  'cover',
  'copyright',
  'dedication',
  'colophon',
  'chapter_divider',
  'toc_divider',
  'image_plate',
  'ornament',
  'text_normal',
  'text_complex',
  'table',
  'figure',
  'mixed',
  'other',
] as const;

export const EMPTY_PAGE_CATEGORIES = ['LEGIT_EMPTY', 'DETECTION_FAILURE', 'UNSURE'] as const;

export const emptyPageCategorySchema = z.enum(EMPTY_PAGE_CATEGORIES);
export const emptyPageTypeSchema = z.enum(EMPTY_PAGE_TYPES);

export type EmptyPageCategoryInput = z.infer<typeof emptyPageCategorySchema>;
export type EmptyPageTypeInput = z.infer<typeof emptyPageTypeSchema>;

const baseUpsertShape = {
  category: emptyPageCategorySchema,
  pageType: emptyPageTypeSchema,
  expectedContent: z.string().trim().max(5000).optional(),
  notes: z.string().trim().max(2000).optional(),
};

// expectedContent is required when category === 'DETECTION_FAILURE' (annotator
// must explain what they expected the page to contain). Optional otherwise.
export const upsertEmptyPageReviewSchema = z
  .object(baseUpsertShape)
  .superRefine((data, ctx) => {
    if (data.category === 'DETECTION_FAILURE') {
      const v = data.expectedContent;
      if (v === undefined || v.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedContent'],
          message: 'expectedContent is required when category is DETECTION_FAILURE',
        });
      }
    }
  });

export type UpsertEmptyPageReviewInput = z.infer<typeof upsertEmptyPageReviewSchema>;

export const pageNumberParamSchema = z.coerce.number().int().positive();
