import { describe, it, expect } from 'vitest';
import {
  EMPTY_PAGE_TYPES,
  pageNumberParamSchema,
  upsertEmptyPageReviewSchema,
} from '../../../src/schemas/empty-page-review.schema';

describe('upsertEmptyPageReviewSchema', () => {
  it('rejects category values not in the enum', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'BOGUS',
      pageType: 'blank',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const onCategory = result.error.issues.some(i => i.path.join('.') === 'category');
      expect(onCategory).toBe(true);
    }
  });

  it('rejects pageType values not in the controlled vocabulary', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'LEGIT_EMPTY',
      pageType: 'half_title',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const onPageType = result.error.issues.some(i => i.path.join('.') === 'pageType');
      expect(onPageType).toBe(true);
    }
  });

  it('rejects DETECTION_FAILURE without expectedContent', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'DETECTION_FAILURE',
      pageType: 'text_normal',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const onExpected = result.error.issues.some(
        i => i.path.join('.') === 'expectedContent',
      );
      expect(onExpected).toBe(true);
    }
  });

  it('rejects DETECTION_FAILURE with empty expectedContent', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'DETECTION_FAILURE',
      pageType: 'text_normal',
      expectedContent: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('accepts DETECTION_FAILURE with non-empty expectedContent', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'DETECTION_FAILURE',
      pageType: 'text_normal',
      expectedContent: 'paragraph of text and a figure',
    });
    expect(result.success).toBe(true);
  });

  it('accepts LEGIT_EMPTY without expectedContent', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'LEGIT_EMPTY',
      pageType: 'blank',
    });
    expect(result.success).toBe(true);
  });

  it('accepts UNSURE without expectedContent', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'UNSURE',
      pageType: 'mixed',
    });
    expect(result.success).toBe(true);
  });

  it('caps notes at 2000 characters', () => {
    const result = upsertEmptyPageReviewSchema.safeParse({
      category: 'LEGIT_EMPTY',
      pageType: 'blank',
      notes: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts every entry of the controlled vocabulary', () => {
    for (const pageType of EMPTY_PAGE_TYPES) {
      const result = upsertEmptyPageReviewSchema.safeParse({
        category: 'LEGIT_EMPTY',
        pageType,
      });
      expect(result.success, `pageType=${pageType} should validate`).toBe(true);
    }
  });

  it('controlled vocabulary matches the frontend PAGE_TYPES list verbatim', () => {
    expect([...EMPTY_PAGE_TYPES]).toEqual([
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
    ]);
  });
});

describe('pageNumberParamSchema', () => {
  it('accepts a positive integer string', () => {
    const r = pageNumberParamSchema.safeParse('5');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(5);
  });

  it('rejects zero', () => {
    expect(pageNumberParamSchema.safeParse('0').success).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(pageNumberParamSchema.safeParse('-3').success).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(pageNumberParamSchema.safeParse('abc').success).toBe(false);
  });

  it('rejects floats', () => {
    expect(pageNumberParamSchema.safeParse('1.5').success).toBe(false);
  });
});
