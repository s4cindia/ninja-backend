/**
 * PostScript Calculator Function Evaluator Tests
 *
 * Focus areas:
 * - Simple, hand-verifiable programs (arithmetic, stack ops, conditionals)
 * - Domain/Range clipping
 * - Strict rejection (null, never throws) of malformed/unsupported programs
 * - The two REAL tint-transform programs extracted from
 *   Math_Olszewski_PDF.pdf's actual DeviceN colorspaces (the document that
 *   surfaced this whole fix) -- real-world regression fixtures, not just
 *   synthetic ones.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePostScriptFunction } from '../../../../src/services/pdf/postscript-function-evaluator';

describe('evaluatePostScriptFunction', () => {
  describe('simple hand-verifiable programs', () => {
    it('{ dup mul } squares its input', () => {
      expect(evaluatePostScriptFunction('{ dup mul }', [0.5], [0, 1], [0, 1])).toEqual([0.25]);
    });

    it('{ 1 exch sub } inverts its input', () => {
      expect(evaluatePostScriptFunction('{ 1 exch sub }', [0.3], [0, 1], [0, 1])).toEqual([0.7]);
    });

    it('{ add } sums two inputs into one output', () => {
      expect(evaluatePostScriptFunction('{ add }', [0.2, 0.5], [0, 1, 0, 1], [0, 1])).toEqual([0.7]);
    });

    it('{ dup } duplicates one input into two identical outputs', () => {
      expect(evaluatePostScriptFunction('{ dup }', [0.4], [0, 1], [0, 1, 0, 1])).toEqual([0.4, 0.4]);
    });

    it('evaluates a true/false conditional with if/ifelse', () => {
      // if input > 0.5, output 1, else output 0.
      const program = '{ 0.5 gt { 1 } { 0 } ifelse }';
      expect(evaluatePostScriptFunction(program, [0.8], [0, 1], [0, 1])).toEqual([1]);
      expect(evaluatePostScriptFunction(program, [0.2], [0, 1], [0, 1])).toEqual([0]);
    });

    it('if (single-branch) only executes its proc when the condition is true', () => {
      // dup's own copy is what the gt check consumes, leaving the
      // original input untouched on the stack for the false case to fall
      // through with -- the true case's proc replaces it with 1.
      const program = '{ dup 0.5 gt { pop 1 } if }';
      expect(evaluatePostScriptFunction(program, [0.8], [0, 1], [0, 1])).toEqual([1]);
      expect(evaluatePostScriptFunction(program, [0.2], [0, 1], [0, 1])).toEqual([0.2]);
    });
  });

  describe('domain/range clipping', () => {
    it('clips an out-of-domain input before running the program', () => {
      // Domain [0, 1] clips 1.5 down to 1 before { dup mul } squares it.
      expect(evaluatePostScriptFunction('{ dup mul }', [1.5], [0, 1], [0, 1])).toEqual([1]);
    });

    it('clips an out-of-range output after running the program', () => {
      // { 2 mul } on 0.8 -> 1.6, clipped down to Range's own max of 1.
      expect(evaluatePostScriptFunction('{ 2 mul }', [0.8], [0, 1], [0, 1])).toEqual([1]);
    });
  });

  describe('strict rejection -- never guesses, never throws', () => {
    it('returns null for unbalanced braces', () => {
      expect(evaluatePostScriptFunction('{ dup mul', [0.5], [0, 1], [0, 1])).toBeNull();
    });

    it('returns null for an unrecognized operator', () => {
      expect(evaluatePostScriptFunction('{ frobnicate }', [0.5], [0, 1], [0, 1])).toBeNull();
    });

    it('returns null on a stack underflow', () => {
      expect(evaluatePostScriptFunction('{ add }', [0.5], [0, 1], [0, 1])).toBeNull();
    });

    it('returns null when a domain/input length mismatch is given', () => {
      expect(evaluatePostScriptFunction('{ dup mul }', [0.5, 0.2], [0, 1], [0, 1])).toBeNull();
    });

    it('returns null when the program leaves fewer values on the stack than range requires', () => {
      expect(evaluatePostScriptFunction('{ pop }', [0.5], [0, 1], [0, 1])).toBeNull();
    });

    it('returns null rather than throwing for a division by zero', () => {
      expect(evaluatePostScriptFunction('{ 0 div }', [0.5], [0, 1], [0, 1])).toBeNull();
    });

    it('does not throw on malformed input generally -- empty program', () => {
      expect(() => evaluatePostScriptFunction('', [0.5], [0, 1], [0, 1])).not.toThrow();
      expect(evaluatePostScriptFunction('', [0.5], [0, 1], [0, 1])).toBeNull();
    });
  });

  describe('real-world fixtures -- extracted directly from Math_Olszewski_PDF.pdf', () => {
    // Both are real DeviceN tint-transform programs (Domain [0 1 0 1],
    // Range [0 1 0 1 0 1 0 1] -- 2 tint inputs, colorant names
    // "Cyan"/"Magenta", 4 CMYK outputs), decompressed directly from the
    // document's own content via pdf-lib + zlib. Confirmed this is the
    // dominant real colorspace family on that document (377 occurrences)
    // and the root cause of its stuck color-contrast fixes.
    const PROGRAM_1 = `{1 index 1.000000 cvr exch sub 3 1 roll 0 index 1.000000 cvr exch sub
3 1 roll 1.000000 3 1 roll 1.000000 3 1 roll 6 -1 roll 1.000000
cvr exch sub 6 1 roll 5 -1 roll 1.000000 cvr exch sub 5 1
roll 4 -1 roll 1.000000 cvr exch sub 4 1 roll 3 -1 roll 1.000000
cvr exch sub 3 1 roll pop pop }`;

    const DOMAIN = [0, 1, 0, 1];
    const RANGE = [0, 1, 0, 1, 0, 1, 0, 1];

    it('program #1: hand-traced for Cyan=0.3, Magenta=0.5 -- resolves to a Cyan/Magenta passthrough into CMYK with Y=K=0', () => {
      // Manually traced through every roll/index/exch/sub step; independently
      // sensible too -- a 2-colorant (Cyan, Magenta) DeviceN space mapping
      // onto CMYK's own C/M channels directly, with Y and K left at 0 since
      // this DeviceN space carries no Yellow or Black colorant at all.
      // toBeCloseTo, not toEqual -- the program's own chain of 1-x
      // subtractions accumulates ordinary IEEE-754 float noise (0.3 comes
      // back as 0.30000000000000004), not a sign of an incorrect result.
      const result = evaluatePostScriptFunction(PROGRAM_1, [0.3, 0.5], DOMAIN, RANGE);
      expect(result).not.toBeNull();
      const [c, m, y, k] = result!;
      expect(c).toBeCloseTo(0.3);
      expect(m).toBeCloseTo(0.5);
      expect(y).toBeCloseTo(0);
      expect(k).toBeCloseTo(0);
    });

    it('program #1: output stays within Range bounds and is deterministic across repeated calls', () => {
      const inputs: [number, number][] = [[0, 0], [1, 1], [0.15, 0.92], [0.6, 0.1]];
      for (const input of inputs) {
        const a = evaluatePostScriptFunction(PROGRAM_1, input, DOMAIN, RANGE);
        const b = evaluatePostScriptFunction(PROGRAM_1, input, DOMAIN, RANGE);
        expect(a).not.toBeNull();
        expect(a).toEqual(b);
        for (const v of a!) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    });

    it('program #2: a second real DeviceN tint-transform from the same document -- parses and evaluates without error, stays within Range bounds', () => {
      const PROGRAM_2 = `{1.000000 2 1 roll 1.000000 2 1 roll 1.000000 2 1 roll 0 index 1.000000
cvr exch sub 2 1 roll 5 -1 roll 1.000000 cvr exch sub 5 1
roll 4 -1 roll 1.000000 cvr exch sub 4 1 roll 3 -1 roll 1.000000
cvr exch sub 3 1 roll 2 -1 roll 1.000000 cvr exch sub 2 1
roll pop }`;
      const result = evaluatePostScriptFunction(PROGRAM_2, [0.3, 0.5], DOMAIN, RANGE);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(4);
      for (const v of result!) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });
});
