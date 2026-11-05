import { describe, it, expect } from 'vitest';
import { findUrlOperatorRun, findEnclosingTagSpan, buildLinkCompletenessSplice } from '../../../../src/services/pdf/pdf-link-completeness-writer';

// Real, live-confirmed shapes from Curiel_187961_CSHP.pdf (2026-11-05) -- a
// reference-list document with zero /Annots anywhere, where citation URLs
// are plain prose sharing a page-level MCID with everything else on the
// page. Checked directly against the real document before writing this
// module at all: on every sampled citation, the URL always arrives as its
// own whole Tj/TJ operator (occasionally 2-3 consecutive ones for a kerning
// gap or hyphen-continuation), never mid-operator alongside unrelated
// prose -- these tests mirror that real shape, not an invented one.
describe('findUrlOperatorRun', () => {
  it('finds a URL that is the entire content of its own single Tj operator', () => {
    // Real shape, page 4: an address line, then a Td to the next line, then
    // the URL alone on its own line.
    const content = `(180 Bloor Street West)Tj\n0 -12 Td\n(M5S 2V6)Tj\n0 -12 Td\n(www.canadianscholars.ca)Tj\n0 -12 Td\n(Copyright 2026)Tj\n`;
    const url = 'www.canadianscholars.ca';
    const run = findUrlOperatorRun(content, 0, content.length, url);
    expect(run).not.toBeNull();
    expect(content.slice(run!.start, run!.end)).toBe('(www.canadianscholars.ca)Tj');
    expect(run!.matchedText).toBe(url);
  });

  it('regression: does not sweep the PREVIOUS line into the match just because it shares no path-paint op with the URL -- real bug, caught against the real document before this fix', () => {
    // Without tracking Td/T*/Tm as hard boundaries between text-show ops,
    // "M5S 2V6" (the previous line's own postal code) and the URL on the
    // NEXT line are adjacent entries in a naive "every text-show op in
    // order" scan, with nothing path-paint-shaped between them to split on
    // -- confirmed live: a first version of this function reported
    // "M5S 2V6www.canadianscholars.ca" as the match for exactly this input.
    const content = `(M5S 2V6)Tj\n0 -12 Td\n(www.canadianscholars.ca)Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'www.canadianscholars.ca');
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe('www.canadianscholars.ca');
    expect(run!.matchedText).not.toContain('M5S 2V6');
  });

  it('merges consecutive text-show ops with no line-break op between them into one run (a kerning-gap/hyphen-continuation URL)', () => {
    // Real shape, page 85: the URL's own tail wraps into a second TJ array
    // after a near-zero kerning adjustment, with no Td/T*/Tm between them --
    // same line, same run, must merge.
    const content = `[(https://endeavors.org/path)]TJ\n[(-continued)]TJ\n( )Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://endeavors.org/path-continued');
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe('https://endeavors.org/path-continued');
  });

  it('declines when matching would sweep more than a small handful of unrelated leading characters into the Link', () => {
    // Real shape, page 102: "Paediatric Society. " (21 chars) sits in the
    // SAME operator as the URL that follows it -- including the whole
    // operator would make a real citation's own prose part of the new
    // Link's extent. Must decline, not guess.
    const content = `(Canadian Paediatric Society. https://kidsnewtocanada.ca/x)Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://kidsnewtocanada.ca/x');
    expect(run).toBeNull();
  });

  it('accepts a small amount of leading punctuation sharing the URL\'s own operator (e.g. ". " before the URL starts)', () => {
    const content = `(. https://example.com/short)Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/short');
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe('. https://example.com/short');
  });

  it('returns null when the target URL does not appear anywhere in range', () => {
    const content = `(Some citation text with no link at all)Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://not-present.example.com');
    expect(run).toBeNull();
  });

  it('returns null for an empty target URL rather than matching everything', () => {
    const content = `(Some text)Tj\n`;
    expect(findUrlOperatorRun(content, 0, content.length, '')).toBeNull();
  });

  it('only searches within the given [rangeStart, rangeEnd) window', () => {
    const content = `(www.outside-the-range.ca)Tj\n(www.inside-the-range.ca)Tj\n`;
    const rangeStart = content.indexOf('(www.inside');
    const run = findUrlOperatorRun(content, rangeStart, content.length, 'www.inside-the-range.ca');
    expect(run).not.toBeNull();
    // The byte offsets returned are absolute (relative to the whole
    // content string), not relative to rangeStart.
    expect(run!.start).toBeGreaterThanOrEqual(rangeStart);
    expect(content.slice(run!.start, run!.end)).toBe('(www.inside-the-range.ca)Tj');
  });

  it('hex-string operand decodes correctly, not just literal parenthesized strings', () => {
    // 77 77 77 2e 68 65 78 2e 63 61 -> "www.hex.ca"
    const content = `<7777772e6865782e6361>Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'www.hex.ca');
    expect(run).not.toBeNull();
    expect(run!.matchedText).toBe('www.hex.ca');
  });
});

// Real, live-confirmed shape from Curiel_187961_CSHP.pdf's REMEDIATED copy
// (2026-11-06, the Seam-C-tagged + Auto-Mode-remediated file an eventual
// fixer actually runs against -- the raw original upload has no structure
// tree or MCID tagging at all, confirmed separately): a reference list's
// entire page is ONE `/P <</MCID 0>> BDC BT ... ET EMC` span, with no
// per-citation sub-tagging. The only OTHER marked content on these pages is
// a handful of tiny `/Span<</ActualText<...>>> BDC ... EMC` wrappers around
// a zero-width-space or soft-hyphen "glue" character (an InDesign
// accessibility convention, unrelated to the citations) -- confirmed live
// on page 85 to sit AFTER every one of that page's 3 real URL runs, never
// around one.
const REAL_PAGE_SHAPE = (beforeText: string, urlText: string, afterText: string): string =>
  `/P <</MCID 0>> BDC BT\n0 0 0 1 k\n/T1_0 1 Tf\n9 0 0 9 99 600 Tm\n[(${beforeText})]TJ\n0 -1.5 Td\n[(${urlText})]TJ\n0 -1.5 Td\n[(${afterText})]TJ\nET EMC`;

describe('findEnclosingTagSpan', () => {
  it('finds the real /P <</MCID 0>> BDC ... EMC span enclosing a position deep inside it', () => {
    const content = REAL_PAGE_SHAPE('Some citation text before', 'https://example.com/url', 'More citation text after');
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/url');
    const enclosing = findEnclosingTagSpan(content, run!.start);
    expect(enclosing).not.toBeNull();
    expect(enclosing!.tag).toBe('P');
    expect(enclosing!.mcid).toBe(0);
    expect(content.slice(enclosing!.closeOpStart, enclosing!.closeOpEnd)).toBe('EMC');
  });

  it('regression: returns null (not a LATER, unrelated tag) when nothing actually encloses the position -- real bug, caught against Curiel_187961_CSHP.pdf\'s own content stream', () => {
    // A first version left `target` unset while the stack was momentarily
    // empty at `position`, then kept scanning and latched onto the NEXT
    // tag it saw open further down the content -- reporting an "enclosing"
    // span whose own contentStart sat AFTER the position it was supposed
    // to enclose. Real, live-confirmed shape: a citation URL sitting at
    // page top level (no enclosing tag at all) with an unrelated
    // ActualText glue-span opening later in the same page.
    const content = `(top-level text, no enclosing tag here)Tj\n/Span<</ActualText<FEFF200B>>> BDC\n( )Tj\nEMC\n`;
    const position = content.indexOf('top-level text');
    expect(findEnclosingTagSpan(content, position)).toBeNull();
  });

  it('targets the INNERMOST open tag, not an outer one, when both enclose the position', () => {
    const content = `/P <</MCID 0>> BDC BT\n/Span<</ActualText<FEFF200B>>> BDC\n( )Tj\nEMC\nET EMC`;
    const position = content.indexOf('( )Tj');
    const enclosing = findEnclosingTagSpan(content, position);
    expect(enclosing).not.toBeNull();
    expect(enclosing!.tag).toBe('Span');
    expect(enclosing!.mcid).toBeNull(); // ActualText dict has no /MCID key
  });

  it('returns null at true top-level content with no enclosing tag anywhere in the page', () => {
    const content = `BT\n(just some text)Tj\nET`;
    expect(findEnclosingTagSpan(content, content.indexOf('just some text'))).toBeNull();
  });
});

describe('buildLinkCompletenessSplice', () => {
  it('splits a clean single-operator URL run out of the real /P <</MCID 0>> span, reattaching the remainder under a fresh MCID', () => {
    const content = REAL_PAGE_SHAPE('Some citation text before', 'https://example.com/url', 'More citation text after');
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/url')!;
    const splice = buildLinkCompletenessSplice(content, run, 500);

    expect(splice).not.toBeNull();
    expect(splice!.enclosingTag).toBe('P');
    expect(splice!.enclosingMcid).toBe(0);
    expect(splice!.linkMcid).toBe(500);
    expect(splice!.remainderMcid).toBe(501); // real "after" text exists -- must be reattached, not dropped
    expect(splice!.edits).toHaveLength(2);

    // Apply right-to-left (same convention every other multi-edit splice in
    // this codebase uses) and confirm the result is well-formed: the URL
    // is still cleanly recoverable, under a real /Link tag, and the
    // remainder text survives under the original tag name with its own
    // fresh MCID.
    let spliced = content;
    for (const edit of [...splice!.edits].sort((a, b) => b.offset - a.offset)) {
      spliced = spliced.slice(0, edit.offset) + edit.text + spliced.slice(edit.offset);
    }
    expect(spliced).toContain('/Link <</MCID 500>> BDC');
    expect(spliced).toContain('/P <</MCID 501>> BDC');
    expect(findUrlOperatorRun(spliced, 0, spliced.length, 'https://example.com/url')!.matchedText).toBe('https://example.com/url');
    expect(spliced).toContain('More citation text after');
  });

  it('does not reopen a remainder span when the URL is the last real content before the enclosing tag\'s own close, even with a trailing ET in between', () => {
    // Real shape: every page in Curiel_187961_CSHP.pdf wraps its entire /P
    // span's content in one BT...ET, so when a URL is the last citation's
    // own last piece of text, what actually sits between the match's end
    // and the enclosing EMC is NOT nothing -- it's the text object's own
    // closing ET. Real PDF syntax, but not content needing its own
    // struct-tree reattachment; must not be mistaken for a real remainder.
    const content = `/P <</MCID 7>> BDC BT\n[(Some text before)]TJ\n0 -1.5 Td\n[(https://example.com/last)]TJ\nET EMC`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/last')!;
    const splice = buildLinkCompletenessSplice(content, run, 500);

    expect(splice).not.toBeNull();
    expect(splice!.remainderMcid).toBeNull();
    expect(splice!.edits).toHaveLength(1); // only the opening close+reopen -- the original EMC now closes /Link directly
  });

  it('reopens a bare, MCID-less remainder when the enclosing span itself had no MCID (e.g. a plain /Artifact)', () => {
    const content = `/Artifact BMC BT\n[(before)]TJ\n0 -1.5 Td\n[(https://example.com/art)]TJ\n0 -1.5 Td\n[(after)]TJ\nET EMC`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/art')!;
    const splice = buildLinkCompletenessSplice(content, run, 500);

    expect(splice).not.toBeNull();
    expect(splice!.enclosingMcid).toBeNull();
    expect(splice!.remainderMcid).toBeNull(); // nothing to re-wire into the structure tree for an Artifact
    const reopenEdit = splice!.edits.find((e) => e.offset === run.end);
    expect(reopenEdit!.text).toBe(' EMC /Artifact BMC ');
  });

  it('declines when the match has no enclosing tag at all', () => {
    const content = `(https://example.com/top-level)Tj\n`;
    const run = findUrlOperatorRun(content, 0, content.length, 'https://example.com/top-level')!;
    expect(buildLinkCompletenessSplice(content, run, 500)).toBeNull();
  });

  it('declines (defensive cross-check) when the matched run extends past the enclosing span\'s own close', () => {
    const content = `/P <</MCID 3>> BDC BT\n[(text)]TJ\nET EMC\n[(https://example.com/outside)]TJ\n`;
    // A run constructed to straddle the EMC above -- not something
    // findUrlOperatorRun would ever produce itself, but buildLinkCompletenessSplice
    // must not assume that invariant always holds from an arbitrary caller.
    const emcEnd = content.indexOf('EMC') + 3;
    const run = { start: emcEnd - 2, end: emcEnd + 5, matchedText: 'C\n[(ht' };
    expect(buildLinkCompletenessSplice(content, run, 500)).toBeNull();
  });
});
