import { describe, it, expect } from 'vitest';
import { stripPgUnsafeChars, stripPgUnsafeCharsDeep } from '../../../src/utils/pg-text';

const NUL = String.fromCharCode(0);

describe('stripPgUnsafeChars', () => {
  it('removes the NUL byte that aborts Postgres text writes', () => {
    expect(stripPgUnsafeChars(`x${NUL}y`)).toBe('xy');
  });

  it('strips a NUL embedded in extracted math text (Nikitopoulos repro)', () => {
    const input = `\\theta ${NUL}= \\frac{1}{2}`;
    const out = stripPgUnsafeChars(input);
    expect(out).not.toBeNull();
    expect(out!.indexOf(NUL)).toBe(-1);
    expect(out).toBe('\\theta = \\frac{1}{2}');
  });

  it('removes other C0 control characters and DEL', () => {
    const input = [0, 1, 8, 11, 12, 14, 31, 127].map((c) => String.fromCharCode(c)).join('A');
    const out = stripPgUnsafeChars(input);
    expect(out).toBe('AAAAAAA');
  });

  it('preserves tab, newline and carriage return', () => {
    expect(stripPgUnsafeChars('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('preserves normal unicode (math symbols, accents)', () => {
    expect(stripPgUnsafeChars('∑ α≤β — café')).toBe('∑ α≤β — café');
  });

  it('returns null for null/undefined', () => {
    expect(stripPgUnsafeChars(null)).toBeNull();
    expect(stripPgUnsafeChars(undefined)).toBeNull();
  });

  it('returns null when the string is empty after stripping', () => {
    expect(stripPgUnsafeChars(NUL + NUL)).toBeNull();
    expect(stripPgUnsafeChars('')).toBeNull();
  });
});

describe('stripPgUnsafeCharsDeep', () => {
  it('strips a NUL buried inside a nested audit-report-shaped object', () => {
    const report = {
      score: 0,
      issues: [
        { code: 'ALT-TEXT-MISSING', message: `Formula on page 3${NUL} has no alt text` },
        { code: 'HEADING-SKIP', message: 'clean message' },
      ],
      matterhornSummary: { categories: [{ name: `Tables${NUL}`, checkpoints: [] }] },
    };

    const cleaned = stripPgUnsafeCharsDeep(report);

    expect(cleaned.issues[0].message).toBe('Formula on page 3 has no alt text');
    expect(cleaned.matterhornSummary.categories[0].name).toBe('Tables');
    expect(JSON.stringify(cleaned).indexOf(NUL)).toBe(-1);
  });

  it('leaves non-string leaves (numbers, booleans, null) unchanged', () => {
    const input = { score: 0, passed: false, note: null, count: 42 };
    expect(stripPgUnsafeCharsDeep(input)).toEqual(input);
  });

  it('handles arrays of primitives directly', () => {
    expect(stripPgUnsafeCharsDeep([`a${NUL}b`, 'c', 3])).toEqual(['ab', 'c', 3]);
  });

  it('handles a bare string the same as stripPgUnsafeChars', () => {
    expect(stripPgUnsafeCharsDeep(`x${NUL}y`)).toBe('xy');
  });
});
