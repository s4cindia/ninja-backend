/**
 * Checkpoint coverage for the byte-offset-mapping primitives the same-
 * operand URL splitter follow-on will build on (not yet wired into any
 * splitting logic -- built and verified in isolation first, per the
 * explicit checkpoint this was scoped with).
 *
 * The real need: given a PDF string literal's own DECODED text position,
 * find the exact byte offset in the literal's RAW SOURCE to cut at --
 * not possible from decoded text alone once a single byte can expand to
 * MULTIPLE decoded characters (a ligature; see decodeTextShowOperands's
 * own GlyphTextResolver, confirmed live on Curiel_187961_CSHP.pdf's own
 * embedded Type1 subset fonts). decodePdfStringLiteralBytes keeps each
 * output byte's own source span; resolveBytesToChars keeps each decoded
 * CHARACTER's own origin byte; findSafeCutPoint composes the two into the
 * actual lookup, declining when a target position falls strictly inside
 * one byte's own multi-character expansion.
 */
import { describe, it, expect } from 'vitest';
import {
  decodePdfStringLiteralBytes,
  resolveBytesToChars,
  findSafeCutPoint,
} from '../../../../src/services/pdf/pdf-link-completeness-writer';

describe('decodePdfStringLiteralBytes', () => {
  it('a plain literal: one source char per byte', () => {
    const bytes = decodePdfStringLiteralBytes('(abc)');
    expect(bytes).toHaveLength(3);
    expect(bytes.map((b) => b.byte)).toEqual(['a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0)]);
    // '(' is index 0; 'a' is index 1.
    expect(bytes[0]).toEqual({ byte: 97, sourceStart: 1, sourceEnd: 2 });
    expect(bytes[1]).toEqual({ byte: 98, sourceStart: 2, sourceEnd: 3 });
    expect(bytes[2]).toEqual({ byte: 99, sourceStart: 3, sourceEnd: 4 });
  });

  it('an octal escape spans its own backslash + digits, not just one source char', () => {
    // \101 octal = 65 = 'A'. Raw: ( a \ 1 0 1 b ) -- indices 0..8.
    const bytes = decodePdfStringLiteralBytes('(a\\101b)');
    expect(bytes.map((b) => b.byte)).toEqual([97, 65, 98]); // 'a', 'A', 'b'
    expect(bytes[0]).toEqual({ byte: 97, sourceStart: 1, sourceEnd: 2 }); // 'a'
    expect(bytes[1]).toEqual({ byte: 65, sourceStart: 2, sourceEnd: 6 }); // '\101' (backslash at 2, digits at 3-5, end at 6)
    expect(bytes[2]).toEqual({ byte: 98, sourceStart: 6, sourceEnd: 7 }); // 'b'
  });

  it('a named escape (\\n) spans its own 2-char source sequence', () => {
    const bytes = decodePdfStringLiteralBytes('(a\\nb)');
    expect(bytes.map((b) => b.byte)).toEqual([97, 10, 98]);
    expect(bytes[1]).toEqual({ byte: 10, sourceStart: 2, sourceEnd: 4 });
  });

  it('a line-continuation escape produces NO byte at all (zero-length in the decoded output)', () => {
    const bytes = decodePdfStringLiteralBytes('(a\\\nb)'); // backslash immediately followed by a real newline
    expect(bytes.map((b) => b.byte)).toEqual([97, 98]); // just 'a' and 'b' -- nothing for the continuation
  });

  it('a hex literal: each digit PAIR maps to one byte at its own real source position', () => {
    const bytes = decodePdfStringLiteralBytes('<68656c6c6f>'); // "hello"
    expect(bytes.map((b) => b.byte)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(bytes[0]).toEqual({ byte: 0x68, sourceStart: 1, sourceEnd: 3 });
    expect(bytes[4]).toEqual({ byte: 0x6f, sourceStart: 9, sourceEnd: 11 });
  });

  it('a hex literal with whitespace between digit pairs still maps to the REAL (unstripped) source positions', () => {
    const bytes = decodePdfStringLiteralBytes('<68 65>'); // "he", with a space between the two pairs
    expect(bytes.map((b) => b.byte)).toEqual([0x68, 0x65]);
    expect(bytes[0]).toEqual({ byte: 0x68, sourceStart: 1, sourceEnd: 3 });
    // The space sits at source index 3; the second pair's own digits are at 4-5.
    expect(bytes[1]).toEqual({ byte: 0x65, sourceStart: 4, sourceEnd: 6 });
  });
});

describe('resolveBytesToChars', () => {
  it('falls back 1:1 to each byte\'s own Latin-1 character when there is no resolver', () => {
    const bytes = decodePdfStringLiteralBytes('(abc)');
    const chars = resolveBytesToChars(bytes, null);
    expect(chars).toEqual([
      { char: 'a', byteIndex: 0 },
      { char: 'b', byteIndex: 1 },
      { char: 'c', byteIndex: 2 },
    ]);
  });

  it('a resolver hit expanding to 2 characters produces two entries sharing the SAME byteIndex', () => {
    // Real shape, Curiel_187961_CSHP.pdf page 31's own T1_0 font: byte 0x1E -> "fi".
    const bytes = decodePdfStringLiteralBytes('(de\x1eles)');
    const resolveGlyphText = (fontTag: string, byteCode: number): string | null =>
      fontTag === '/T1_0' && byteCode === 0x1e ? 'fi' : null;
    const chars = resolveBytesToChars(bytes, '/T1_0', resolveGlyphText);
    expect(chars.map((c) => c.char).join('')).toBe('defiles');
    // 'd'(0) 'e'(1) -- then the ligature byte (index 2) produces BOTH 'f' and 'i'.
    expect(chars[2]).toEqual({ char: 'f', byteIndex: 2 });
    expect(chars[3]).toEqual({ char: 'i', byteIndex: 2 });
    expect(chars[4]).toEqual({ char: 'l', byteIndex: 3 });
  });

  it('a resolver miss for one specific byte falls back to that byte\'s own Latin-1 character, others still resolve', () => {
    const bytes = decodePdfStringLiteralBytes('(a\x1db)'); // 0x1D in the middle
    const resolveGlyphText = (fontTag: string, byteCode: number): string | null =>
      byteCode === 0x1e ? 'fi' : null; // only resolves 0x1E, not 0x1D
    const chars = resolveBytesToChars(bytes, '/T1_0', resolveGlyphText);
    expect(chars.map((c) => c.char).join('')).toBe('a\x1db'); // 0x1D falls back unresolved
  });
});

describe('findSafeCutPoint', () => {
  // Real shape, Curiel_187961_CSHP.pdf page 31: "de" + ligature "fi" (byte
  // 0x1E) + "les" -- the real "default/files" case this whole follow-on
  // exists for.
  const raw = '(de\x1eles)';
  const bytes = decodePdfStringLiteralBytes(raw);
  const resolveGlyphText = (fontTag: string, byteCode: number): string | null =>
    fontTag === '/T1_0' && byteCode === 0x1e ? 'fi' : null;
  const chars = resolveBytesToChars(bytes, '/T1_0', resolveGlyphText);
  // Decoded text is "defiles": d-e-f-i-l-e-s, indices 0..6.

  it('cutting at index 0 (before everything) lands at the literal\'s own opening bound', () => {
    expect(findSafeCutPoint(bytes, chars, 0)).toBe(bytes[0].sourceStart); // right after '('
  });

  it('cutting at the full length (after everything) lands at the literal\'s own closing bound', () => {
    expect(findSafeCutPoint(bytes, chars, chars.length)).toBe(bytes[bytes.length - 1].sourceEnd); // right before ')'
  });

  it('cutting right BEFORE the ligature byte\'s own expansion is safe', () => {
    // decodedIndex 2 = right before "fi" starts (after "de").
    const cut = findSafeCutPoint(bytes, chars, 2);
    expect(cut).not.toBeNull();
    expect(cut).toBe(bytes[2].sourceStart); // the ligature byte's own source position
    // Confirm it round-trips: slicing raw at this offset separates "de" from "filès" cleanly.
    expect(raw.slice(bytes[0].sourceStart, cut!)).toBe('de');
  });

  it('cutting right AFTER the ligature byte\'s own expansion is safe', () => {
    // decodedIndex 4 = right after "fi" ends (before "les").
    const cut = findSafeCutPoint(bytes, chars, 4);
    expect(cut).not.toBeNull();
    expect(cut).toBe(bytes[2].sourceEnd); // right after that one byte's own source span
    expect(raw.slice(cut!, bytes[bytes.length - 1].sourceEnd)).toBe('les');
  });

  it('cutting STRICTLY INSIDE the ligature\'s own two-character expansion is unsafe -- declines', () => {
    // decodedIndex 3 = between 'f' and 'i', both produced by the SAME byte.
    expect(findSafeCutPoint(bytes, chars, 3)).toBeNull();
  });

  it('every other (non-ligature) boundary in this same literal is safe', () => {
    // "d|efiles", "de|files" (already covered above), "defiles|" (already covered).
    expect(findSafeCutPoint(bytes, chars, 1)).toBe(bytes[1].sourceStart);
  });
});
