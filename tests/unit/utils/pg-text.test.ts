import { describe, it, expect } from 'vitest';
import { stripPgUnsafeChars } from '../../../src/utils/pg-text';

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
