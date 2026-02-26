import { describe, it, expect } from 'vitest';
import { extractCitationNumbers, citationNumbersMatch, isCitationOrphaned } from '../../../src/utils/citation.utils';

describe('extractCitationNumbers', () => {
  it('extracts single number from parentheses', () => {
    expect(extractCitationNumbers('(3)')).toEqual([3]);
  });

  it('extracts single number from brackets', () => {
    expect(extractCitationNumbers('[5]')).toEqual([5]);
  });

  it('extracts comma-separated numbers', () => {
    expect(extractCitationNumbers('(1, 2, 3)')).toEqual([1, 2, 3]);
  });

  it('extracts compact comma-separated numbers', () => {
    expect(extractCitationNumbers('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('expands hyphen ranges', () => {
    expect(extractCitationNumbers('[3-5]')).toEqual([3, 4, 5]);
  });

  it('expands en-dash ranges', () => {
    expect(extractCitationNumbers('(2\u20134)')).toEqual([2, 3, 4]);
  });

  it('handles mixed comma and range', () => {
    expect(extractCitationNumbers('(1, 3-5)')).toEqual([1, 3, 4, 5]);
  });

  it('returns sorted unique numbers', () => {
    expect(extractCitationNumbers('(5, 1, 3)')).toEqual([1, 3, 5]);
  });

  it('extracts year from author-year citations (higher-level filtering needed)', () => {
    // extractCitationNumbers is format-agnostic; it extracts any pure-digit tokens
    // Author-year filtering happens at the caller level (e.g., numericCitationTypes check)
    expect(extractCitationNumbers('(Bender et al., 2021)')).toEqual([2021]);
  });

  it('returns empty for empty string', () => {
    expect(extractCitationNumbers('')).toEqual([]);
  });

  it('guards against pathological ranges (>200 span)', () => {
    const result = extractCitationNumbers('[1-10000000]');
    expect(result).toEqual([]);
  });

  it('allows ranges up to 200 span', () => {
    const result = extractCitationNumbers('[1-201]');
    expect(result).toHaveLength(201);
    expect(result[0]).toBe(1);
    expect(result[200]).toBe(201);
  });
});

describe('citationNumbersMatch', () => {
  it('matches identical formats', () => {
    expect(citationNumbersMatch('(1)', '(1)')).toBe(true);
  });

  it('matches brackets vs parentheses', () => {
    expect(citationNumbersMatch('[1]', '(1)')).toBe(true);
  });

  it('matches spaced vs compact', () => {
    expect(citationNumbersMatch('(1, 2, 3)', '(1,2,3)')).toBe(true);
  });

  it('matches expanded vs range', () => {
    expect(citationNumbersMatch('(2, 3, 4)', '(2-4)')).toBe(true);
  });

  it('matches brackets range vs parentheses expanded', () => {
    expect(citationNumbersMatch('[3-5]', '(3, 4, 5)')).toBe(true);
  });

  it('returns false for different numbers', () => {
    expect(citationNumbersMatch('(1)', '(2)')).toBe(false);
  });

  it('returns false for different length', () => {
    expect(citationNumbersMatch('(1, 2)', '(1)')).toBe(false);
  });

  it('returns false for empty-vs-empty', () => {
    expect(citationNumbersMatch('', '')).toBe(false);
  });

  it('returns false for non-numeric text', () => {
    expect(citationNumbersMatch('(Bender, 2021)', '(Marcus, 2019)')).toBe(false);
  });
});

describe('isCitationOrphaned', () => {
  it('returns true for NUMERIC with no links', () => {
    expect(isCitationOrphaned([], 'NUMERIC')).toBe(true);
  });

  it('returns false for NUMERIC with links', () => {
    expect(isCitationOrphaned([1], 'NUMERIC')).toBe(false);
  });

  it('returns false for non-linkable types', () => {
    expect(isCitationOrphaned([], 'REFERENCE')).toBe(false);
  });

  it('returns true for PARENTHETICAL with no links', () => {
    expect(isCitationOrphaned([], 'PARENTHETICAL')).toBe(true);
  });
});
