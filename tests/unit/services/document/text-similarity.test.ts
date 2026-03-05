import { describe, it, expect } from 'vitest';
import { _testing } from '../../../../src/services/document/docx-conversion.service';

const { computeWordSimilarity, computeSequenceSimilarity, tokenize } = _testing;

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('returns empty array for empty/whitespace input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('handles mixed case and trailing punctuation', () => {
    expect(tokenize('Introduction: METHODS, results.')).toEqual(['introduction', 'methods', 'results']);
  });
});

describe('computeWordSimilarity', () => {
  it('returns 1 for identical texts', () => {
    expect(computeWordSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for texts differing only in case/punctuation', () => {
    // After tokenize lowercases and strips punctuation these are identical
    expect(computeWordSimilarity('Hello, World!', 'hello world')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(computeWordSimilarity('', '')).toBe(1); // both empty → exact match shortcut
    expect(computeWordSimilarity('hello', '')).toBe(0);
    expect(computeWordSimilarity('', 'hello')).toBe(0);
  });

  it('returns 0 for completely different texts', () => {
    expect(computeWordSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('handles multiset correctly (repeated words)', () => {
    // "the the cat" vs "the cat" → intersection min(2,1)+min(1,1)=1+1=2, union max(2,1)+max(1,1)=2+1=3
    const sim = computeWordSimilarity('the the cat', 'the cat');
    expect(sim).toBeCloseTo(2 / 3, 5);
  });

  it('is order-insensitive (reordered text scores 1.0)', () => {
    expect(computeWordSimilarity('one two three', 'three two one')).toBe(1);
  });

  it('returns high similarity for minor edits in long text', () => {
    const base = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const edited = base.replace('word50', 'changed50');
    const sim = computeWordSimilarity(base, edited);
    // 99 shared out of 101 unique → ~0.98
    expect(sim).toBeGreaterThan(0.95);
  });
});

describe('computeSequenceSimilarity', () => {
  it('returns 1 for identical texts', () => {
    expect(computeSequenceSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(computeSequenceSimilarity('hello', '')).toBe(0);
    expect(computeSequenceSimilarity('', 'hello')).toBe(0);
  });

  it('detects reordering (lower score than word similarity)', () => {
    const original = 'alpha beta gamma delta epsilon';
    const reordered = 'epsilon delta gamma beta alpha';
    const wordSim = computeWordSimilarity(original, reordered);
    const seqSim = computeSequenceSimilarity(original, reordered);
    // Word similarity should be 1.0 (same words), sequence should be much lower
    expect(wordSim).toBe(1);
    expect(seqSim).toBeLessThan(0.5);
  });

  it('returns high score for identical order with minor edits', () => {
    const base = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const edited = base.replace('word25', 'changed25');
    const sim = computeSequenceSimilarity(base, edited);
    expect(sim).toBeGreaterThan(0.9);
  });

  it('handles single-token inputs', () => {
    expect(computeSequenceSimilarity('hello', 'hello')).toBe(1);
    expect(computeSequenceSimilarity('hello', 'world')).toBe(0);
  });
});

describe('dual-check behavior', () => {
  it('reordered paragraphs: word sim high but sequence sim low', () => {
    const para1 = 'The quick brown fox jumps over the lazy dog';
    const para2 = 'A systematic review was conducted following guidelines';
    const original = `${para1} ${para2}`;
    const reordered = `${para2} ${para1}`;

    const wordSim = computeWordSimilarity(original, reordered);
    const seqSim = computeSequenceSimilarity(original, reordered);

    // Both would pass 0.95 word threshold but sequence should fail 0.90
    expect(wordSim).toBe(1);
    expect(seqSim).toBeLessThan(0.90);
  });
});
