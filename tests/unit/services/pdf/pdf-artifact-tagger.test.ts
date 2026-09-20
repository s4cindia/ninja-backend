import { describe, it, expect } from 'vitest';
import { findUntaggedPathRuns, tagUntaggedPaintedPaths } from '../../../../src/services/pdf/pdf-artifact-tagger';

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
