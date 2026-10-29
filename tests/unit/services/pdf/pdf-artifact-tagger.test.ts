import { describe, it, expect } from 'vitest';
import {
  findUntaggedPathRuns,
  tagUntaggedPaintedPaths,
  findTaggedContentInsideArtifact,
  splitArtifactAroundTaggedContent,
  findOversizedArtifactSpans,
  extractArtifactTextRuns,
  computeHeuristicBoundaryIndex,
  applyArtifactUnwrap,
} from '../../../../src/services/pdf/pdf-artifact-tagger';

describe('findUntaggedPathRuns', () => {
  it('finds a single untagged painted-path run', () => {
    const content = `0 0 m\n10 10 l\nS\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ start: 0, end: content.indexOf('S') + 1, hasCurves: false });
  });

  it('ignores a path used only for clipping (ends in n, not a paint op)', () => {
    const content = `0 0 100 100 re\nW n\n`;
    expect(findUntaggedPathRuns(content)).toHaveLength(0);
  });

  it('does not flag a path already inside a real structure tag', () => {
    const content = `/P <</MCID 0 >>BDC\n0 0 m\n10 10 l\nS\nEMC\n`;
    expect(findUntaggedPathRuns(content)).toHaveLength(0);
  });

  it('does not flag a path already inside an existing Artifact tag', () => {
    const content = `/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n`;
    expect(findUntaggedPathRuns(content)).toHaveLength(0);
  });

  it('reproduces the real Math_Weir_PDF.pdf shape: a table header fill + zebra-striped row fills, separated only by color-set operators, merge into ONE run', () => {
    // Simplified real excerpt (page 34): a dark header-row fill, a color
    // change, then a batch of alternating light zebra-stripe row fills --
    // all untagged, nothing but "k" (color) operators between them.
    const content =
      `0 0 0 0.7 k\n` +
      `199.2 729.26 260.4 -19.18 re\n` +
      `f\n` +
      `0 0 0 0.08 k\n` +
      `199.2 710.08 260.4 -18.462 re\n` +
      `199.2 673.156 260.4 -18.462 re\n` +
      `f\n` +
      `0 0 0 0.12 k\n` +
      `199.2 691.618 260.4 -18.462 re\n` +
      `f\n`;

    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
    // Starts at the FIRST re's own operand (not the preceding "0 0 0 0.7 k"
    // color-set, which sits outside the run — matches Seam-C's own
    // pathStart convention) and ends at the LAST f.
    expect(runs[0].start).toBe(content.indexOf('199.2 729.26'));
    expect(runs[0].end).toBe(content.lastIndexOf('f\n') + 1);
  });

  it('breaks a run at a real marked-content boundary rather than merging across it', () => {
    const content =
      `0 0 m\n10 10 l\nS\n` +          // untagged path 1
      `/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n` + // real tagged content in between
      `20 20 m\n30 30 l\nS\n`;          // untagged path 2

    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(2);
  });

  it('breaks a run at BT rather than merging across untagged text', () => {
    const content = `0 0 m\n10 10 l\nS\nBT\n(x)Tj\nET\n20 20 m\n30 30 l\nS\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(2);
  });

  it('marks a run containing a Bezier curve operator (c/v/y) as hasCurves', () => {
    const content = `0 0 m\n10 10 20 20 30 30 c\nS\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
    expect(runs[0].hasCurves).toBe(true);
  });

  it('marks a straight-line-only run (m/l/re/h) as NOT hasCurves', () => {
    const content = `0 0 m\n10 10 l\n0 0 100 100 re\nh\nS\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
    expect(runs[0].hasCurves).toBe(false);
  });

  it('propagates hasCurves across a merged run: one curve anywhere in the merge taints the whole run', () => {
    const content =
      `0 0 m\n10 10 l\nf\n` +          // straight-line unit 1
      `0 0 0 0.5 k\n` +                 // color-set (doesn't break the merge)
      `20 20 m\n5 5 10 10 15 15 c\nf\n`; // curved unit 2 -- same merged run
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
    expect(runs[0].hasCurves).toBe(true);
  });

  it('does not flag a path inside /OC BDC (optional-content layer marker) as already-tagged -- OC is not an accessibility tag', () => {
    // CodeRabbit finding: a naive "any BDC/BMC means tagged" check produces
    // a false negative here, since /OC controls layer visibility and has
    // nothing to do with structure/artifact tagging.
    const content = `/OC /MC0 BDC\n0 0 m\n10 10 l\nS\nEMC\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
  });

  it('still suppresses detection for a path genuinely inside a real tag nested INSIDE an /OC layer', () => {
    const content = `/OC /MC0 BDC\n/P <</MCID 0 >>BDC\n0 0 m\n10 10 l\nS\nEMC\nEMC\n`;
    expect(findUntaggedPathRuns(content)).toHaveLength(0);
  });

  it('correctly resumes untagged detection after a real tag closes inside an outer /OC layer', () => {
    // Nesting order: OC(false) -> real(true) -> EMC pops real -> depth back
    // to 0 (still inside OC, which never counted) -> next path IS untagged.
    const content =
      `/OC /MC0 BDC\n` +
      `/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n` +
      `20 20 m\n30 30 l\nS\n` +
      `EMC\n`;
    const runs = findUntaggedPathRuns(content);
    expect(runs).toHaveLength(1);
  });

  it('does not corrupt an inline image by parsing its binary payload as path operators', () => {
    // CodeRabbit finding: a real bug where BI's binary payload (unparseable
    // as tokens) could contain byte sequences that look like "m"/"l"/"S"
    // and get misdetected as an untagged path run, then have /Artifact BMC
    // spliced directly into the image data.
    const content = `BI\n/W 2/H 1/BPC 8/CS/G\nID \x00m 0 0 l S\x00\nEI\n0 0 m\n5 5 l\nS\n`;
    const runs = findUntaggedPathRuns(content);
    // Only the REAL untagged path after EI is found -- nothing inside the
    // inline image's own binary span.
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBeGreaterThan(content.indexOf('EI'));
  });

  it('never splices into inline image binary data when applying the fix', () => {
    const content = `BI\n/W 2/H 1/BPC 8/CS/G\nID \x00m 0 0 l S\x00\nEI\n`;
    const result = tagUntaggedPaintedPaths(content);
    // Nothing outside the image is untagged, and the image itself must be
    // left byte-for-byte untouched.
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('reproduces the real Math_Weir_PDF.pdf crop-mark shape: two short tick-mark paths per page, both untagged', () => {
    const content =
      `q 1 0 0 1 15 816 cm\n` +
      `0 0 m\n-15 0 l\n630 0 m\n645 0 l\n` +
      `S\n` +
      `Q\n` +
      `1 SCN\n0.5 w\n` +
      `q 1 0 0 1 15 816 cm\n` +
      `0 0 m\n-15 0 l\n` +
      `S\n` +
      `Q\n`;
    const runs = findUntaggedPathRuns(content);
    // "q ... cm" before the first "m" doesn't start a run on its own (only
    // path-construction ops do); the two S-terminated path sequences are
    // separated by "Q\n1 SCN\n0.5 w\nq ... cm" -- all non-boundary
    // operators, so they merge into a single run, matching the real
    // document (the whole crop-mark region tags as one Artifact).
    expect(runs).toHaveLength(1);
  });
});

describe('tagUntaggedPaintedPaths', () => {
  it('returns the original string unchanged when nothing needs tagging', () => {
    const content = `/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n`;
    const result = tagUntaggedPaintedPaths(content);
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('wraps a single untagged run in a bare /Artifact BMC ... EMC (not BDC)', () => {
    // EMC lands right after the "S" operator itself, before the trailing
    // newline -- the run's `end` is the operator's own end offset, not the
    // whitespace that happens to follow it.
    const content = `0 0 m\n10 10 l\nS\n`;
    const result = tagUntaggedPaintedPaths(content);
    expect(result.count).toBe(1);
    expect(result.content).toBe(`/Artifact BMC 0 0 m\n10 10 l\nS EMC \n`);
  });

  it('never emits /Artifact BDC (would need an undeclared /Properties entry -- the real veraPDF-confirmed bug this deliberately avoids)', () => {
    const content = `0 0 m\n10 10 l\nS\n`;
    const result = tagUntaggedPaintedPaths(content);
    expect(result.content).not.toContain('/Artifact BDC');
    expect(result.content).not.toContain('/Artifact <<');
  });

  it('wraps multiple separate runs independently, each with its own bare Artifact tag', () => {
    const content = `0 0 m\n10 10 l\nS\nBT\n(x)Tj\nET\n20 20 m\n30 30 l\nS\n`;
    const result = tagUntaggedPaintedPaths(content);
    expect(result.count).toBe(2);
    expect((result.content.match(/\/Artifact BMC/g) ?? []).length).toBe(2);
    expect((result.content.match(/EMC/g) ?? []).length).toBe(2);
    // The untagged BT/ET text in between is left completely untouched --
    // out of scope for this module (see class doc comment).
    expect(result.content).toContain('BT\n(x)Tj\nET\n');
  });

  it('preserves the exact original bytes of the wrapped region, byte for byte', () => {
    const content = `q\n0 0 0 0.7 k\n199.2 729.26 260.4 -19.18 re\nf\nQ\n`;
    const result = tagUntaggedPaintedPaths(content);
    // Original path bytes must still be present verbatim inside the wrap --
    // this fix only inserts tag operators, never rewrites path geometry.
    expect(result.content).toContain('199.2 729.26 260.4 -19.18 re\nf');
  });

  it('round-trips real, multi-run Math_Weir_PDF.pdf page content correctly', () => {
    // A miniature but structurally real page: real tagged text, an
    // untagged table-shading fill, more real tagged text, then untagged
    // crop marks -- confirms independent runs interleaved with real
    // content are each wrapped correctly and nothing else is touched.
    const content =
      `/P <</MCID 0 >>BDC\nBT\n9 0 0 9 100 700 Tm\n(Header)Tj\nET\nEMC\n` +
      `0 0 0 0.7 k\n100 690 200 -19 re\nf\n` +
      `/P <</MCID 1 >>BDC\nBT\n9 0 0 9 100 650 Tm\n(3.14)Tj\nET\nEMC\n` +
      `0 0 m\n-15 0 l\nS\n`;

    const result = tagUntaggedPaintedPaths(content);
    expect(result.count).toBe(2);
    expect(result.content).toContain('(Header)Tj');
    expect(result.content).toContain('(3.14)Tj');
    expect(result.content).toContain('/Artifact BMC 100 690 200 -19 re\nf EMC');
    expect(result.content).toContain('/Artifact BMC 0 0 m\n-15 0 l\nS EMC');
  });
});

describe('findTaggedContentInsideArtifact', () => {
  it('finds no violation when there is no Artifact at all', () => {
    const content = `/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(0);
  });

  it('finds no violation when real content sits beside (not inside) an Artifact', () => {
    const content = `/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(0);
  });

  it('detects a real tag nested directly inside an Artifact span, at the tag NAME offset not the BDC operator offset', () => {
    const content = `/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n`;
    const violations = findTaggedContentInsideArtifact(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].closeArtifactBefore).toBe(content.indexOf('/Span'));
    expect(violations[0].reopenArtifactAfter).toBe(content.indexOf('EMC\nEMC') + 'EMC'.length);
  });

  it('only reports the OUTERMOST real tag when one real tag is nested inside another, both inside an Artifact', () => {
    const content = `/Artifact BMC\n/P <</MCID 0 >>BDC\n/Span <</MCID 1 >>BDC\n(x)Tj\nEMC\nEMC\nEMC\n`;
    const violations = findTaggedContentInsideArtifact(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].closeArtifactBefore).toBe(content.indexOf('/P'));
  });

  it('detects a violation even with an Artifact TWO levels up the ancestor chain', () => {
    const content = `/Artifact BMC\n/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(1);
  });

  it('does not treat /OC (optional-content layer) as either an Artifact or real content', () => {
    // An /OC-wrapped real tag inside an Artifact is still a real violation
    // -- OC is unrelated to accessibility semantics and must not provide
    // cover.
    const content = `/Artifact BMC\n/OC /MC0 BDC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(1);
  });

  it('does not flag two separate back-to-back real tags as two independent nesting levels', () => {
    const content = `/Artifact BMC\n/Span <</MCID 0 >>BDC\n(a)Tj\nEMC\n/Span <</MCID 1 >>BDC\n(b)Tj\nEMC\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(2);
  });

  it('does not corrupt an inline image by parsing its binary payload as marked-content operators', () => {
    const content = `/Artifact BMC\nBI\n/W 2/H 1/BPC 8/CS/G\nID \x00/Span BDC EMC\x00\nEI\nEMC\n`;
    expect(findTaggedContentInsideArtifact(content)).toHaveLength(0);
  });
});

describe('splitArtifactAroundTaggedContent', () => {
  it('returns the original string unchanged when there is nothing to split', () => {
    const content = `/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n`;
    const result = splitArtifactAroundTaggedContent(content);
    expect(result.count).toBe(0);
    expect(result.content).toBe(content);
  });

  it('splits a single nested real tag out of its enclosing Artifact', () => {
    const content = `/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n`;
    const result = splitArtifactAroundTaggedContent(content);
    expect(result.count).toBe(1);
    // The real tag's own bytes are untouched and still present verbatim.
    expect(result.content).toContain('/Span <</MCID 0 >>BDC\n(x)Tj\nEMC');
    // The Artifact is closed right before the real tag opens, and reopened
    // right after it closes -- both insertions carry a leading space so
    // they can never merge with whatever precedes them into a garbage
    // token (confirmed real: an unspaced "EMC" landing right after a bare
    // keyword like "BT" tokenizes as "BTEMC", silently swallowing the fix).
    expect(result.content).toBe(`/Artifact BMC\n EMC /Span <</MCID 0 >>BDC\n(x)Tj\nEMC /Artifact BMC \nEMC\n`);
  });

  it('merges a run of back-to-back real tags into a single excised block, not one split per tag', () => {
    const content = `/Artifact BMC\n/Span <</MCID 0 >>BDC\n(a)Tj\nEMC\n/Span <</MCID 1 >>BDC\n(b)Tj\nEMC\nEMC\n`;
    const result = splitArtifactAroundTaggedContent(content);
    expect(result.count).toBe(2);
    // Exactly one close-then-reopen pair around the WHOLE back-to-back
    // block, not an empty open/close Artifact wedged between the two Spans.
    expect((result.content.match(/\/Artifact BMC/g) ?? []).length).toBe(2); // original open + one reopen after the block
    expect((result.content.match(/EMC/g) ?? []).length).toBe(4); // 2 real Span EMCs + 1 early-close + 1 final close
    expect(result.content).not.toMatch(/EMC\s*\/Artifact BMC\s*\/Span/); // no empty wedge between the two Spans
  });

  it('regression: never merges the inserted EMC with a bare preceding keyword like BT into a garbage token (confirmed real on Farrar_2E_Comp_188910.pdf page 68: "BT/Span" with no space)', () => {
    // The real shape: a text object's own BT is immediately followed, with
    // no whitespace, by the nested real tag's BDC -- exactly the case
    // where an unspaced "EMC" insertion would tokenize as "BTEMC" (a
    // single, unrecognized operator), silently swallowing the fix and
    // leaving the Artifact open.
    const content = `/Artifact BMC\nBT/Span <</MCID 1 >>BDC\n(GLOSSARY)Tj EMC\nET\nEMC\n/Table <</MCID 0 >>BDC\n(data)Tj\nEMC\n`;
    const before = findTaggedContentInsideArtifact(content);
    expect(before).toHaveLength(1); // /Table is NOT nested (Artifact already closed by then)

    const result = splitArtifactAroundTaggedContent(content);
    expect(result.count).toBe(1);

    const after = findTaggedContentInsideArtifact(result.content);
    expect(after).toHaveLength(0);
    // The real tag's own bytes are untouched and still present verbatim.
    expect(result.content).toContain('/Span <</MCID 1 >>BDC\n(GLOSSARY)Tj EMC');
  });

  it('never touches path/text operator bytes, only marked-content boundaries', () => {
    const content = `/Artifact BMC\n/Span <</MCID 0 >>BDC\nBT\n9 0 0 9 100 700 Tm\n(Header)Tj\nET\nEMC\nEMC\n`;
    const result = splitArtifactAroundTaggedContent(content);
    expect(result.content).toContain('(Header)Tj');
    expect(result.content).toContain('9 0 0 9 100 700 Tm');
  });
});

describe('findOversizedArtifactSpans', () => {
  const buildPage = (bodyTjCount: number): string => {
    const header = `10 0 0 10 50 800 Tm\n(5)Tj\n10 0 0 10 100 800 Tm\n(Running Head)Tj\n`;
    const body = Array.from({ length: bodyTjCount }, (_, i) => `10 0 0 10 50 ${700 - i * 10} Tm\n(Paragraph line ${i})Tj\n`).join('');
    return `/Artifact BMC\nBT\n${header}${body}ET\nEMC\n`;
  };

  it('does not flag a small legitimate Artifact span (op count at or below threshold)', () => {
    // 2 Tj calls total (just a page number + running head) -- well under
    // even a generously low threshold.
    const content = buildPage(0);
    expect(findOversizedArtifactSpans(content, 2)).toHaveLength(0);
  });

  it('flags a top-level Artifact span whose op count exceeds the threshold', () => {
    const content = buildPage(10); // 2 header Tj + 10 body Tj = 12 ops
    const spans = findOversizedArtifactSpans(content, 5);
    expect(spans).toHaveLength(1);
    expect(spans[0].opCount).toBe(12);
    expect(spans[0].openOpStart).toBe(content.indexOf('BMC'));
    expect(spans[0].contentStart).toBe(content.indexOf('BMC') + 'BMC'.length);
    expect(spans[0].closeOpStart).toBe(content.lastIndexOf('EMC'));
    expect(spans[0].hasPathOps).toBe(false);
  });

  it('uses the real-document-confirmed default threshold (15) when none is passed', () => {
    // A legitimate real header/footer confirmed to be 1-10 ops must not be
    // flagged at the default threshold.
    const content = buildPage(3); // 2 + 3 = 5 ops, well under 15
    expect(findOversizedArtifactSpans(content)).toHaveLength(0);
  });

  it('marks hasPathOps when a path-paint operator appears inside, in addition to text', () => {
    const content = `/Artifact BMC\nBT\n${Array.from({ length: 10 }, (_, i) => `(line ${i})Tj\n`).join('')}ET\n0 0 m\n10 10 l\nS\nEMC\n`;
    const spans = findOversizedArtifactSpans(content, 5);
    expect(spans).toHaveLength(1);
    expect(spans[0].hasPathOps).toBe(true);
  });

  it('does not treat a NESTED Artifact (inside a real tag) as a top-level oversized span', () => {
    // The outer wrapper here is a real /P, not /Artifact -- an inner
    // Artifact nested inside it never starts at depth 0, so it's simply
    // not this function's concern regardless of its own op count.
    const innerOps = Array.from({ length: 20 }, (_, i) => `(line ${i})Tj\n`).join('');
    const content = `/P <</MCID 0 >>BDC\n/Artifact BMC\nBT\n${innerOps}ET\nEMC\nEMC\n`;
    expect(findOversizedArtifactSpans(content, 5)).toHaveLength(0);
  });

  it('does not corrupt an inline image by parsing its binary payload as content ops', () => {
    const content = `/Artifact BMC\nBI\n/W 2/H 1/BPC 8/CS/G\nID \x00m 0 0 l S\x00\nEI\nEMC\n`;
    expect(findOversizedArtifactSpans(content, 0)).toHaveLength(0);
  });
});

describe('extractArtifactTextRuns', () => {
  it('extracts each text run with its decoded text and device-space Y from the most recent Tm', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n(Header)Tj\n10 0 0 10 50 700 Tm\n(Body)Tj\nET\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ text: 'Header', y: 800 });
    expect(runs[1]).toMatchObject({ text: 'Body', y: 700 });
  });

  it('ignores text-show calls entirely outside the given range', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n(Before)Tj\n10 0 0 10 50 700 Tm\n(Inside)Tj\nET\n`;
    const rangeStart = content.indexOf('(Inside)') - 20; // starts after "Before"'s own Tj
    const runs = extractArtifactTextRuns(content, rangeStart, content.length);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Inside');
  });

  it('decodes escaped characters in a string literal operand', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n(Line one \\(escaped\\) and \\n newline)Tj\nET\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Line one (escaped) and \n newline');
  });

  it('concatenates TJ array string operands in order, ignoring kerning numbers', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n[(Hel)-20(lo)]TJ\nET\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Hello');
  });

  it('omits a whitespace-only text-show call', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n( )Tj\n10 0 0 10 50 700 Tm\n(Real)Tj\nET\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Real');
  });

  it('tracks baseline Y across Td (relative) moves, not just Tm (absolute)', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n(Header)Tj\n0 -50 Td\n(Body)Tj\nET\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(2);
    expect(runs[1].y).toBe(750);
  });

  it('does not corrupt an inline image by parsing its binary payload as text operators', () => {
    const content = `BT\n10 0 0 10 50 800 Tm\n(Real)Tj\nET\nBI\n/W 2/H 1/BPC 8/CS/G\nID \x00(fake)Tj\x00\nEI\n`;
    const runs = extractArtifactTextRuns(content, 0, content.length);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Real');
  });
});

describe('computeHeuristicBoundaryIndex', () => {
  it('returns 0 for fewer than 2 runs', () => {
    expect(computeHeuristicBoundaryIndex([])).toBe(0);
    expect(computeHeuristicBoundaryIndex([{ text: 'a', start: 0, y: 100 }])).toBe(0);
  });

  it('finds the index of the single largest consecutive Y-drop', () => {
    // Confirmed real shape: a running head at the top, then a large drop
    // to the first real paragraph, then small, consistent line-to-line
    // drops within the paragraph.
    const runs = [
      { text: 'Running Head', start: 0, y: 800 },
      { text: 'First real paragraph line one', start: 10, y: 700 }, // big drop: 100
      { text: 'line two', start: 20, y: 690 }, // small drop: 10
      { text: 'line three', start: 30, y: 680 }, // small drop: 10
    ];
    expect(computeHeuristicBoundaryIndex(runs)).toBe(1);
  });
});

describe('applyArtifactUnwrap', () => {
  it('inserts a leading-space-safe close-Artifact/open-Span sequence at the given offset', () => {
    const content = `/Artifact BMC\n(decorative)Tj\n(real content)Tj\nEMC\n`;
    const realContentStart = content.indexOf('(real content)');
    const result = applyArtifactUnwrap(content, realContentStart, 3);
    expect(result).toBe(
      `/Artifact BMC\n(decorative)Tj\n EMC /Span <</MCID 3>> BDC (real content)Tj\nEMC\n`
    );
  });

  it('leaves everything before the insertion point byte-for-byte unchanged', () => {
    const content = `/Artifact BMC\n(decorative header text)Tj\n(real)Tj\nEMC\n`;
    const realContentStart = content.indexOf('(real)');
    const result = applyArtifactUnwrap(content, realContentStart, 0);
    expect(result.slice(0, realContentStart)).toBe(content.slice(0, realContentStart));
  });

  it("the pre-existing closing EMC now correctly closes the new Span, not the Artifact -- confirmed by exactly one EMC appearing before the new Span's own BDC never closes it prematurely", () => {
    const content = `/Artifact BMC\n(decorative)Tj\n(real)Tj\nEMC\n`;
    const realContentStart = content.indexOf('(real)');
    const result = applyArtifactUnwrap(content, realContentStart, 7);
    // Exactly one EMC exists after the new BDC (the original one, now
    // closing the Span) -- no second EMC was inserted.
    const afterBdc = result.slice(result.indexOf('BDC'));
    expect((afterBdc.match(/EMC/g) ?? []).length).toBe(1);
  });
});
