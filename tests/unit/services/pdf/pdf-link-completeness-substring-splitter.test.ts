/**
 * Regression coverage for the same-operand URL splitter (the 30.1%+5.3%
 * "shares an operand with other prose" bucket findUrlOperatorRun declines
 * -- see pdf-link-completeness-writer.ts's own header comment for the
 * full, measured breakdown). findUrlSubstringRun locates the match with no
 * leftover cap and computes the exact cut points needed on either edge;
 * buildUrlSubstringSplice turns those into real content-stream edits.
 *
 * Every fixture here mirrors a REAL confirmed shape from
 * Curiel_187961_CSHP.pdf: a leading lead-in phrase sharing one Tj's own
 * literal with the URL (the dominant real shape, "Retrieved from ",
 * "StatPearls Publishing. ", etc.), a TJ array where the lead-in is its
 * own separate element (the MORE common real shape per the full-population
 * sweep -- most real cuts land at an existing array-element boundary, not
 * mid-literal), and the real page-31 ligature case.
 */
import { describe, it, expect } from 'vitest';
import {
  findUrlOperatorRun,
  findUrlSubstringRun,
  buildUrlSubstringSplice,
  type GlyphTextResolver,
} from '../../../../src/services/pdf/pdf-link-completeness-writer';

function applyEdits(content: string, edits: Array<{ offset: number; text: string }>): string {
  let out = content;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.text + out.slice(edit.offset);
  }
  return out;
}

describe('findUrlSubstringRun', () => {
  it('declines to even try -- same as findUrlOperatorRun -- when the leftover is within the clean-path cap (not this module\'s job)', () => {
    // Sanity: this function doesn't special-case "already clean" inputs;
    // it will happily locate a run with small leftover too. Real callers
    // only ever invoke it AFTER findUrlOperatorRun has already declined.
    const content = `/T1_0 1 Tf\n(. https://example.com/short)Tj\n`;
    const run = findUrlSubstringRun(content, 0, content.length, 'https://example.com/short');
    expect(run).not.toBeNull();
  });

  it('a leading lead-in phrase sharing the SAME literal as the URL (real shape: "Retrieved from ...") needs a mid-literal cut', () => {
    const content = `/T1_0 1 Tf\n(Retrieved from https://example.com/doc)Tj\n`;
    const url = 'https://example.com/doc';
    const run = findUrlSubstringRun(content, 0, content.length, url);
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe(url);
    // Mid-literal cut: needs its own fresh delimiter + a synthetic Tj close.
    expect(run!.leadingCut.closeSuffix).toBe(') Tj');
    expect(run!.leadingCut.openPrefix).toBe('(');
    // Nothing follows the URL in this literal -- trailing cut is a clean operator boundary.
    expect(run!.trailingCut.closeSuffix).toBe('');
    expect(run!.trailingCut.openPrefix).toBe('');
  });

  it('a lead-in phrase that is its OWN separate TJ array element needs only a piece-boundary cut, no byte split', () => {
    // Real shape (the MORE common one per the full-population sweep): the
    // lead-in and the URL are separate array elements, not one literal.
    const content = `/T1_0 1 Tf\n[(Retrieved from )(https://example.com/doc)]TJ\n`;
    const url = 'https://example.com/doc';
    const run = findUrlSubstringRun(content, 0, content.length, url);
    expect(run).not.toBeNull();
    // Piece boundary within an array: needs the array/operator wrapper, but no literal delimiter.
    expect(run!.leadingCut.closeSuffix).toBe('] TJ');
    expect(run!.leadingCut.openPrefix).toBe('[');
  });

  it('trailing text sharing the same literal (real shape, page 73) needs a mid-literal cut on the trailing edge', () => {
    const content = `/T1_0 1 Tf\n(https://example.com/doc trailing text)Tj\n`;
    const url = 'https://example.com/doc';
    const run = findUrlSubstringRun(content, 0, content.length, url);
    expect(run).not.toBeNull();
    expect(run!.leadingCut.closeSuffix).toBe(''); // URL starts exactly at the operator's own start
    expect(run!.trailingCut.closeSuffix).toBe(') Tj');
    expect(run!.trailingCut.openPrefix).toBe('(');
    expect(run!.hasTrailingContentInSameOp).toBe(true);
  });

  it('real shape, Curiel_187961_CSHP.pdf page 31: a ligature INSIDE the URL itself does not interfere with a cut at the (different) leading edge', () => {
    const resolveGlyphText: GlyphTextResolver = (fontTag, byteCode) => (fontTag === '/T1_0' && byteCode === 0x1e ? 'fi' : null);
    const content = `/T1_0 1 Tf\n(Retrieved from https://example.com/de\x1eles)Tj\n`;
    const url = 'https://example.com/defiles';
    const run = findUrlSubstringRun(content, 0, content.length, url, resolveGlyphText, () => true);
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe(url);
  });

  it('declines (does not guess) when the ONLY available cut point falls strictly inside a ligature\'s own expansion', () => {
    // The leading leftover ends exactly where the ligature's own "f" sits
    // -- cutting there would require splitting "fi" into "f"/"i".
    const resolveGlyphText: GlyphTextResolver = (fontTag, byteCode) => (fontTag === '/T1_0' && byteCode === 0x1e ? 'fi' : null);
    // Target URL is "iles..." -- starts one character INTO the "fi" ligature's own expansion.
    const content = `/T1_0 1 Tf\n(de\x1eles.example.com)Tj\n`;
    const run = findUrlSubstringRun(content, 0, content.length, 'iles.example.com', resolveGlyphText, () => true);
    expect(run).toBeNull();
  });

  it('declines when the active font is reported as not simple (CID/Type0) -- out of scope, never attempted', () => {
    const content = `/T1_0 1 Tf\n(Retrieved from https://example.com/doc)Tj\n`;
    const url = 'https://example.com/doc';
    const run = findUrlSubstringRun(content, 0, content.length, url, undefined, () => false);
    expect(run).toBeNull();
  });

  it('declines when no font was ever selected (unknown font, cannot verify safety) and a mid-literal cut would be needed', () => {
    const content = `(Retrieved from https://example.com/doc)Tj\n`; // no Tf at all
    const run = findUrlSubstringRun(content, 0, content.length, 'https://example.com/doc');
    expect(run).toBeNull();
  });
});

describe('buildUrlSubstringSplice', () => {
  const PAGE_CONTENT = (inner: string) => `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n${inner}\nET EMC`;

  it('splits a leading lead-in phrase out of a bare Tj, and the result round-trips through findUrlOperatorRun cleanly', () => {
    const url = 'https://example.com/doc';
    const content = PAGE_CONTENT(`(Retrieved from ${url})Tj`);
    const run = findUrlSubstringRun(content, 0, content.length, url)!;
    const splice = buildUrlSubstringSplice(content, run, 500)!;
    expect(splice).not.toBeNull();
    expect(splice.linkMcid).toBe(500);

    const fixed = applyEdits(content, splice.edits);
    expect(fixed).toContain('EMC /Link <</MCID 500>> BDC');
    expect(fixed).toContain(`(${url})`);
    expect(fixed).toContain('(Retrieved from )'); // leading leftover now its own, properly closed literal
    // Round-trip: the clean path should now find the URL as its own whole run.
    const reRun = findUrlOperatorRun(fixed, 0, fixed.length, url);
    expect(reRun).not.toBeNull();
    expect(reRun!.matchedText).toBe(url);
  });

  it('splits a piece-boundary lead-in (TJ array) with no byte-level cut, and round-trips cleanly', () => {
    const url = 'https://example.com/doc';
    const content = PAGE_CONTENT(`[(Retrieved from )(${url})]TJ`);
    const run = findUrlSubstringRun(content, 0, content.length, url)!;
    const splice = buildUrlSubstringSplice(content, run, 500)!;

    const fixed = applyEdits(content, splice.edits);
    expect(fixed).toContain('] TJ EMC /Link <</MCID 500>> BDC [');
    const reRun = findUrlOperatorRun(fixed, 0, fixed.length, url);
    expect(reRun).not.toBeNull();
    expect(reRun!.matchedText).toBe(url);
  });

  it('assigns a fresh remainder MCID when real trailing content shares the operator, and round-trips cleanly', () => {
    const url = 'https://example.com/doc';
    const content = PAGE_CONTENT(`(${url} trailing text)Tj`);
    const run = findUrlSubstringRun(content, 0, content.length, url)!;
    const splice = buildUrlSubstringSplice(content, run, 500)!;

    expect(splice.remainderMcid).toBe(501);
    const fixed = applyEdits(content, splice.edits);
    expect(fixed).toContain('EMC /P <</MCID 501>> BDC');
    expect(fixed).toContain('( trailing text)'); // leading space preserved verbatim from the original literal
    const reRun = findUrlOperatorRun(fixed, 0, fixed.length, url);
    expect(reRun!.matchedText).toBe(url);
  });

  it('does NOT assign a remainder when the URL is the last real content before the enclosing tag\'s own close', () => {
    const url = 'https://example.com/doc';
    const content = PAGE_CONTENT(`(Retrieved from ${url})Tj`);
    const run = findUrlSubstringRun(content, 0, content.length, url)!;
    const splice = buildUrlSubstringSplice(content, run, 500)!;
    expect(splice.remainderMcid).toBeNull();
    expect(splice.edits).toHaveLength(1); // only the leading cut
  });

  it('end-to-end real shape, Curiel_187961_CSHP.pdf page 31: leading leftover + a ligature inside the URL itself', () => {
    const resolveGlyphText: GlyphTextResolver = (fontTag, byteCode) => (fontTag === '/T1_0' && byteCode === 0x1e ? 'fi' : null);
    const url = 'https://example.com/defiles';
    const content = PAGE_CONTENT(`(Retrieved from https://example.com/de\x1eles)Tj`);
    const run = findUrlSubstringRun(content, 0, content.length, url, resolveGlyphText, () => true)!;
    expect(run).not.toBeNull();
    const splice = buildUrlSubstringSplice(content, run, 500)!;
    const fixed = applyEdits(content, splice.edits);
    expect(fixed).toContain('EMC /Link <</MCID 500>> BDC');
    expect(fixed).toContain('(Retrieved from )');
    // The ligature byte survives untouched, byte-for-byte, inside the new /Link span's own literal.
    expect(fixed).toContain('(https://example.com/de\x1eles)');
  });

  it('declines when there is no enclosing tag at all', () => {
    const url = 'https://example.com/doc';
    const content = `/T1_0 1 Tf\n(Retrieved from ${url})Tj\n`; // no enclosing BDC at all
    const run = findUrlSubstringRun(content, 0, content.length, url)!;
    expect(buildUrlSubstringSplice(content, run, 500)).toBeNull();
  });
});
