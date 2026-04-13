import { describe, it, expect } from 'vitest';
import { markCompleteBodySchema } from '../../../src/schemas/mark-complete.schema';

describe('markCompleteBodySchema', () => {
  it('accepts an empty body (backwards compatibility)', () => {
    const result = markCompleteBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a full valid body with multiple categories', () => {
    const result = markCompleteBodySchema.safeParse({
      pagesReviewed: 42,
      notes: 'fine',
      issues: [
        { category: 'PAGE_ALIGNMENT_MISMATCH', pagesAffected: 3 },
        { category: 'INSUFFICIENT_JOINT_COVERAGE', blocking: true },
        { category: 'LIMITED_ZONE_COVERAGE', description: 'partial' },
        { category: 'UNEQUAL_EXTRACTOR_COVERAGE' },
        { category: 'SINGLE_EXTRACTOR_ONLY' },
        { category: 'ZONE_CONTENT_DIVERGENCE' },
        { category: 'COMPLETED_WITH_REDUCED_SCOPE' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toHaveLength(7);
      expect(result.data.issues?.[1]?.blocking).toBe(true);
      // description defaults to empty string when omitted
      expect(result.data.issues?.[0]?.description).toBe('');
    }
  });

  it('rejects OTHER category without a description', () => {
    const result = markCompleteBodySchema.safeParse({
      pagesReviewed: 10,
      issues: [{ category: 'OTHER' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasDescErr = result.error.issues.some(i => i.path.includes('description'));
      expect(hasDescErr).toBe(true);
    }
  });

  it('rejects OTHER category with whitespace-only description', () => {
    const result = markCompleteBodySchema.safeParse({
      pagesReviewed: 10,
      issues: [{ category: 'OTHER', description: '   ' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts OTHER category with a meaningful description', () => {
    const result = markCompleteBodySchema.safeParse({
      pagesReviewed: 10,
      issues: [{ category: 'OTHER', description: 'extractor timed out on scanned pages' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown category', () => {
    const result = markCompleteBodySchema.safeParse({
      issues: [{ category: 'DOES_NOT_EXIST' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects pagesReviewed < 1', () => {
    const result = markCompleteBodySchema.safeParse({ pagesReviewed: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer pagesReviewed', () => {
    const result = markCompleteBodySchema.safeParse({ pagesReviewed: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects negative pagesAffected', () => {
    const result = markCompleteBodySchema.safeParse({
      issues: [{ category: 'PAGE_ALIGNMENT_MISMATCH', pagesAffected: -2 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects notes longer than 2000 chars', () => {
    const result = markCompleteBodySchema.safeParse({ notes: 'x'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 1000 chars', () => {
    const result = markCompleteBodySchema.safeParse({
      issues: [{ category: 'PAGE_ALIGNMENT_MISMATCH', description: 'x'.repeat(1001) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown top-level keys (strict mode)', () => {
    const result = markCompleteBodySchema.safeParse({ pagesReviewed: 5, bogus: true });
    expect(result.success).toBe(false);
  });

  it('defaults blocking to false when omitted', () => {
    const result = markCompleteBodySchema.safeParse({
      issues: [{ category: 'PAGE_ALIGNMENT_MISMATCH' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues?.[0]?.blocking).toBe(false);
    }
  });
});
