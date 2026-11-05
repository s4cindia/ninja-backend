import { describe, it, expect } from 'vitest';
import { findUrlOperatorRun } from '../../../../src/services/pdf/pdf-link-completeness-writer';

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
