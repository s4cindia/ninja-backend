import { describe, it, expect } from 'vitest';
import {
  corpusRangeQuerySchema,
  resolveCorpusRange,
} from '../../../src/schemas/corpus-summary.schema';

describe('corpusRangeQuerySchema', () => {
  it('accepts date-only strings (YYYY-MM-DD) per spec', () => {
    const parsed = corpusRangeQuerySchema.safeParse({ from: '2026-04-01', to: '2026-04-13' });
    expect(parsed.success).toBe(true);
  });

  it('accepts full ISO-8601 datetimes with offset', () => {
    const parsed = corpusRangeQuerySchema.safeParse({
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-13T23:59:59.999+05:30',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty object (both params optional)', () => {
    const parsed = corpusRangeQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed date strings', () => {
    const parsed = corpusRangeQuerySchema.safeParse({ from: 'yesterday' });
    expect(parsed.success).toBe(false);
  });

  it('rejects impossible calendar dates', () => {
    const parsed = corpusRangeQuerySchema.safeParse({ from: '2026-02-31' });
    expect(parsed.success).toBe(false);
  });

  it('rejects datetimes without timezone offset', () => {
    // Naive datetimes are ambiguous → reject to keep the UTC contract clear.
    const parsed = corpusRangeQuerySchema.safeParse({ from: '2026-04-01T12:00:00' });
    expect(parsed.success).toBe(false);
  });

  it('rejects from > to', () => {
    const parsed = corpusRangeQuerySchema.safeParse({
      from: '2026-04-13',
      to: '2026-04-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts same-day from = to when both are date-only', () => {
    // from normalizes to 00:00Z, to normalizes to 23:59Z, so this is valid.
    const parsed = corpusRangeQuerySchema.safeParse({
      from: '2026-04-05',
      to: '2026-04-05',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('resolveCorpusRange', () => {
  it('normalizes date-only `from` to start of UTC day', () => {
    const { from } = resolveCorpusRange({ from: '2026-04-01', to: '2026-04-13' });
    expect(from.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('normalizes date-only `to` to end of UTC day', () => {
    const { to } = resolveCorpusRange({ from: '2026-04-01', to: '2026-04-13' });
    expect(to.toISOString()).toBe('2026-04-13T23:59:59.999Z');
  });

  it('preserves full datetime `from` and `to` exactly as supplied', () => {
    const { from, to } = resolveCorpusRange({
      from: '2026-04-01T09:30:00Z',
      to: '2026-04-13T17:45:00Z',
    });
    expect(from.toISOString()).toBe('2026-04-01T09:30:00.000Z');
    expect(to.toISOString()).toBe('2026-04-13T17:45:00.000Z');
  });

  it('defaults to last 30 days when both params omitted', () => {
    const before = Date.now();
    const { from, to } = resolveCorpusRange({});
    const after = Date.now();

    // `to` ≈ now
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime()).toBeLessThanOrEqual(after);
    // `from` ≈ to − 30 days
    const spanMs = to.getTime() - from.getTime();
    expect(spanMs).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -2);
  });

  it('defaults `from` to 30 days before `to` when only `to` is supplied', () => {
    const { from, to } = resolveCorpusRange({ to: '2026-04-13' });
    expect(to.toISOString()).toBe('2026-04-13T23:59:59.999Z');
    const spanMs = to.getTime() - from.getTime();
    expect(spanMs).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -2);
  });
});
