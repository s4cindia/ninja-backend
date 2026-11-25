/**
 * Regression coverage for HEADING-STYLE-MISMATCH's dispatch routing --
 * analyzeHeadingStyleMismatch, the new AI classification pass built on top
 * of a previously detect-only validator (see heading-style-classifier.ts's
 * own header and the "Heading-Style-Mismatch Classifier Design" doc,
 * https://claude.ai/artifact/4CwarLbLEjpTgALdFgnUBD).
 *
 * Uses a REAL tagged-PDF fixture (same approach as
 * pdf-heading-style-mismatch.validator.test.ts and
 * pdf-structure-writer-heading-promote.test.ts) rather than a lightweight
 * mock -- this method re-parses real pdfjs structure data
 * (collectHeadingStyleData), which a stub parsed object can't stand in for.
 * geminiService.generateWithSchema and fileStorageService.getFile (the
 * ORIGINAL-upload read getOriginalFileBodyMedianFontSize does for its
 * bodyMedianFontSize denominator, see ai-analysis.service.ts) are mocked;
 * everything else, including the comprehensive re-parse of that "original"
 * buffer, runs for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { pdfHeadingStyleMismatchValidator } from '../../../../src/services/pdf/validators/pdf-heading-style-mismatch.validator';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// dispatchIssue is private; exercise via cast, same pattern as every other
// *-routing.test.ts in this suite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const CONFIG: AiRemediationConfig = {
  tableFixMode: 'apply-to-pdf',
  altTextMode: 'apply-to-pdf',
  listMode: 'auto-resolve-decorative',
  languageMode: 'apply-to-pdf',
  colorContrastMode: 'guidance-only',
  linkTextMode: 'guidance-only',
  formFieldMode: 'guidance-only',
  bookmarkMode: 'guidance-only',
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

const PAGE_WIDTH = 2400;
const PAGE_HEIGHT = 792;

interface Line {
  text: string;
  y: number;
  size: number;
  zoneType?: 'paragraph' | 'section-header';
}

function zoneForLine(line: Line): OrderableZone {
  return {
    pageNumber: 1,
    zoneType: line.zoneType ?? 'paragraph',
    bbox: { x: 40, y: PAGE_HEIGHT - line.y - line.size * 0.75, w: PAGE_WIDTH - 80, h: line.size * 1.5 },
  };
}

const FIXTURE_FILE_NAME = 'heading-style-mismatch-routing-fixture.pdf';

async function buildTaggedDoc(lines: Line[]): Promise<{ parsedPdf: ParsedPDF; buffer: Buffer }> {
  const src = await PDFDocument.create();
  const page = src.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    page.drawText(line.text, { x: 60, y: line.y, size: line.size, font, color: rgb(0, 0, 0) });
  }
  const doc = await PDFDocument.load(await src.save());
  const zones: OrderableZone[] = lines.map(zoneForLine);
  buildStructTreeFromZones(doc, zones);
  const buffer = Buffer.from(await doc.save());
  const parsedPdf = await pdfParserService.parseBuffer(buffer, FIXTURE_FILE_NAME);
  return { parsedPdf, buffer };
}

// No buildStructTreeFromZones call -- a plain, untagged PDF with drawn
// text and no structure tree at all, same shape as a real original
// upload before Auto Mode ever tags it (e.g. the corpus's own T4/T5
// titles).
async function buildUntaggedBuffer(lines: Line[]): Promise<Buffer> {
  const src = await PDFDocument.create();
  const page = src.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    page.drawText(line.text, { x: 60, y: line.y, size: line.size, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await src.save());
}

// getOriginalFileBodyMedianFontSize reads the job's ORIGINAL upload via
// fileStorageService.getFile -- these tests have no real job/S3/local
// storage, so this mocks that one read to resolve to the SAME buffer the
// test just built (there's no multi-round remediation here, so "original"
// and "current" are the same document, matching the single-call shape
// every other test in this file already exercises).
function mockOriginalFile(buffer: Buffer) {
  vi.spyOn(fileStorageService, 'getFile').mockResolvedValue(buffer);
}

const BODY_LINES: Line[] = [
  { text: 'The annual report summarizes revenue growth across every regional division for the fiscal year.', y: 680, size: 11 },
  { text: 'Operating margins improved due to disciplined cost management throughout the organization.', y: 630, size: 11 },
  { text: 'Customer retention remained strong despite increased competitive pressure in core markets.', y: 580, size: 11 },
  { text: 'The board approved a new capital allocation framework prioritizing shareholder returns.', y: 480, size: 11 },
  { text: 'International expansion continued with two new offices opened during the second half.', y: 430, size: 11 },
  { text: 'Supply chain investments reduced lead times and improved on-time delivery performance.', y: 380, size: 11 },
];

async function dispatchFirstIssue(parsedPdf: ParsedPDF, buffer: Buffer) {
  mockOriginalFile(buffer);
  const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
  expect(audit.issues).toHaveLength(1);
  const issue = audit.issues[0];
  const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
  const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map(), new Map(), 'test-job', 'test-tenant', FIXTURE_FILE_NAME);
  return { issue, res };
}

describe('dispatchIssue: HEADING-STYLE-MISMATCH routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts a heading-promote-fix suggestion when the model says this is a genuine heading at high confidence', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Reads as a genuine section title introducing the report.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const { parsedPdf, buffer } = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf, buffer);

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('heading-promote-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.confidence).toBe(0.9);
    expect(['1', '2', '3']).toContain(res.value);
  });

  it('still asks the model for a large font-size cluster, but declines when the model reads it as a repeated decorative style (cluster size is a confidence penalty, not a hard pre-call gate)', async () => {
    // Real incident (Karsaklian_189165_9781606497623.pdf, 2026-11-17): a
    // hard pre-call decline here used to block ~30 of that file's REAL,
    // systematically mistagged section headings -- they formed exactly
    // this large-same-size-short-candidates shape, indistinguishable from
    // a genuine repeated decorative style by cluster size and length
    // alone. Only the model reading actual text content can tell them
    // apart (see the next test for the "genuinely mistagged" side of that
    // same shape) -- so cluster size now only reduces confidence
    // (LARGE_CLUSTER_PENALTY), it never skips the call outright.
    const spy = vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: false, confidence: 0.15, rationale: 'Reads as a quoted sentence repeated for emphasis, not a section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 9 paragraphs at the SAME heading-sized font -- just past
    // CLUSTER_SIZE_DECLINE_THRESHOLD (8) -- packed into their own
    // non-overlapping y-range below many more normal-sized body paragraphs,
    // so the body-text MEDIAN still correctly lands on the size-11 majority
    // rather than being skewed by the size-22 cluster itself.
    const manyBodyLines: Line[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Ordinary body sentence number ${i + 1} describing routine operational detail.`,
      y: 780 - i * 18,
      size: 11,
    }));
    const pullQuoteLines: Line[] = Array.from({ length: 9 }, (_, i) => ({
      text: `Pull quote number ${i + 1} goes here`,
      y: 60 + i * 35,
      size: 22,
    }));
    const manyLines: Line[] = [...manyBodyLines, ...pullQuoteLines];
    const { parsedPdf, buffer } = await buildTaggedDoc(manyLines);
    mockOriginalFile(buffer);
    const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    expect(audit.issues.length).toBeGreaterThan(0);

    const issue = audit.issues[0];
    const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map(), new Map(), 'test-job', 'test-tenant', FIXTURE_FILE_NAME);

    expect(spy).toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('promotes a genuine heading despite a large same-size cluster, when the model is confident enough to survive the penalty (the Karsaklian shape itself)', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Reads as a genuine, repeated section-title pattern, not decorative text.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Same large-cluster shape as the test above, EXCEPT every instance is
    // a real, short section title rather than a pull-quote -- the exact
    // ambiguity cluster size alone cannot resolve.
    const manyBodyLines: Line[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Ordinary body sentence number ${i + 1} describing routine operational detail.`,
      y: 780 - i * 18,
      size: 11,
    }));
    const sectionTitleLines: Line[] = Array.from({ length: 9 }, (_, i) => ({
      text: `Section ${i + 1} Overview`,
      y: 60 + i * 35,
      size: 22,
    }));
    const manyLines: Line[] = [...manyBodyLines, ...sectionTitleLines];
    const { parsedPdf, buffer } = await buildTaggedDoc(manyLines);
    mockOriginalFile(buffer);
    const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    expect(audit.issues.length).toBeGreaterThan(0);

    const issue = audit.issues[0];
    const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map(), new Map(), 'test-job', 'test-tenant', FIXTURE_FILE_NAME);

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('heading-promote-fix');
    expect(res.confidence).toBeCloseTo(0.75, 5); // 0.9 raw - 0.15 large-cluster penalty
    expect(res.rationale).toContain('confidence reduced');
  });

  it('declines when the model itself says this is not a heading', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: false, confidence: 0.1, rationale: 'Reads as a decorative pull-quote, not a section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const { parsedPdf, buffer } = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf, buffer);

    expect(res).toBeNull();
  });

  it('declines when confidence falls below the floor even though the model said isHeading: true', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.2, rationale: 'Weak signal either way.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const { parsedPdf, buffer } = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf, buffer);

    expect(res).toBeNull();
  });

  it('reduces confidence when a confirmed real heading elsewhere already uses the exact same font size', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Looks heading-like.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // A genuine H1 (section-header zone) at size 28, PLUS a mismatched /P
    // candidate at the SAME size 28 elsewhere on the page -- the negative
    // signal the design doc's confirmed decision folds into confidence.
    const lines: Line[] = [
      { text: 'Chapter One', y: 760, size: 28, zoneType: 'section-header' },
      { text: 'Executive Summary', y: 320, size: 28 },
      ...BODY_LINES,
    ];
    const { parsedPdf, buffer } = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf, buffer);

    expect(res).not.toBeNull();
    expect(res.confidence).toBeCloseTo(0.8, 5); // 0.9 raw - 0.1 penalty
    expect(res.rationale).toContain('confidence reduced');
  });

  it('gives the same boundary candidate the same level across two rounds, even though the WORKING file lost a /P (promoted away) between them -- real bug, 2026-11-25 (see git log): bodyMedianFontSize used to be recomputed from whatever /P population remained in the current doc, so a promotion elsewhere could shift the median enough to flip a boundary candidate H2 vs H3. Fixed by sourcing the median from the job\'s ORIGINAL upload instead, which this test mocks to the SAME buffer for both rounds.', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Reads as a genuine section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Original /P population (round 1, nothing promoted yet): body sizes
    // 9, 11, 13, 15, 17 + a large OTHER paragraph at 50 + the BOUNDARY
    // candidate at 26 -- ALL seven are part of collectHeadingStyleData's
    // own median population (it doesn't exclude the candidate under test).
    // Sorted: [9,11,13,15,17,26,50] -- median (7 values) = 15.
    // Boundary ratio = 26/15 = 1.733 -- under the 1.8 H2 cutoff -> H3.
    const originalLines: Line[] = [
      { text: 'A paragraph at the smallest body size used in this fixture.', y: 700, size: 9 },
      { text: 'A paragraph at a somewhat larger body size than the smallest one.', y: 660, size: 11 },
      { text: 'A paragraph at a middling body size for this fixture.', y: 620, size: 13 },
      { text: 'A paragraph at a somewhat larger body size than middling.', y: 580, size: 15 },
      { text: 'A paragraph at the largest plain body size in this fixture.', y: 540, size: 17 },
      { text: 'Some Other Paragraph That Will Be Promoted Away Later', y: 460, size: 50 },
      { text: 'Possible Section Title', y: 380, size: 26 },
    ];
    const { buffer: originalBuffer } = await buildTaggedDoc(originalLines);

    // "Round 1" current doc: identical to the original -- nothing
    // promoted yet.
    const { parsedPdf: round1Doc } = await buildTaggedDoc(originalLines);

    // "Round 2" current doc: the SAME document, except "Some Other
    // Paragraph..." is now tagged as a heading (zoneType: 'section-header')
    // instead of a /P -- simulating it having already been promoted in an
    // earlier round. Without the fix, collectHeadingStyleData's own median
    // over the REMAINING /P population (sorted [9,11,13,15,17,26], 6
    // values, median (13+15)/2=14) gives the SAME boundary candidate a
    // ratio of 26/14 = 1.857 -- OVER the 1.8 cutoff, flipping it to H2.
    // The fix must prevent this by always sourcing the median from the
    // unchanged ORIGINAL file (median 15, ratio 1.733, H3) instead.
    const round2Lines: Line[] = originalLines.map((line) =>
      line.text.startsWith('Some Other Paragraph') ? { ...line, zoneType: 'section-header' as const } : line
    );
    const { parsedPdf: round2Doc } = await buildTaggedDoc(round2Lines);

    const getLevelForBoundaryCandidate = async (parsedPdf: ParsedPDF) => {
      const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
      // Round 1 also flags "Some Other Paragraph..." (size 30, well above
      // the ratio threshold too) -- match on the boundary candidate's own
      // text, which the validator quotes verbatim in its issue message.
      const issue = audit.issues.find((i) => i.message.includes('Possible Section Title'));
      expect(issue).toBeDefined();
      const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
      vi.spyOn(fileStorageService, 'getFile').mockResolvedValue(originalBuffer);
      const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map(), new Map(), 'test-job', 'test-tenant', FIXTURE_FILE_NAME);
      expect(res).not.toBeNull();
      return res.value;
    };

    const round1Level = await getLevelForBoundaryCandidate(round1Doc);
    const round2Level = await getLevelForBoundaryCandidate(round2Doc);

    expect(round1Level).toBe('3');
    expect(round2Level).toBe('3'); // same as round 1 -- NOT '2', which is what the pre-fix bug would have produced
  });

  it('computes a real, non-zero body median against an UNTAGGED original upload -- real gap caught on review, 2026-11-25 (see git log): collectHeadingStyleData only walks the pdfjs STRUCT TREE, so it returns bodyMedianFontSize=0 for a source with no structure tree at all. T4 and T5 in the real corpus are both untagged originals (the whole document gets tagged for the first time during Auto Mode) -- reading the original-file median via collectHeadingStyleData would have returned 0 permanently for every untagged-source title, forcing every promoted heading to H3 regardless of its real size. Fixed by computeContentStreamBodyMedianFontSize, which reads font sizes from pdfjs getTextContent() directly and needs no structure tree.', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Reads as a genuine section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // The "original upload": same text/sizes as the CURRENT doc below, but
    // with no structure tree at all -- collectHeadingStyleData(original)
    // would see zero /P elements and return bodyMedianFontSize=0.
    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const untaggedOriginal = await buildUntaggedBuffer(lines);
    vi.spyOn(fileStorageService, 'getFile').mockResolvedValue(untaggedOriginal);

    // The "current" doc: already auto-tagged by the time Auto Mode's
    // analysis pass runs (as it would be, in reality, for an
    // originally-untagged title) -- same content, now with real /P
    // candidates to flag and promote.
    const { parsedPdf } = await buildTaggedDoc(lines);
    const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    expect(audit.issues).toHaveLength(1);
    const issue = audit.issues[0];
    const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map(), new Map(), 'test-job', 'test-tenant', FIXTURE_FILE_NAME);

    expect(res).not.toBeNull();
    // Content-stream median of the original is ~11pt (dominated by the 6
    // BODY_LINES, all size 11; the one size-28 line is a minor outlier).
    // Ratio 28/11 ~= 2.5 -- well over the 2.2 H1 cutoff. Without the fix
    // (median=0 from an untagged original), this would be forced to '3'
    // regardless of the candidate's real size.
    expect(res.value).toBe('1');
  });

  it('takes the level of an existing heading at the same font size instead of the ratio cutoff, even when the ratio would give a different answer', async () => {
    // Real bug, 2026-11-25 (see git log): the ratio cutoff alone is a sharp
    // step function that a noise-level font-size difference between
    // otherwise-identical runs can land on either side of, flipping a
    // promoted heading's level -- which fixHeadingHierarchy's own correct
    // gap-closing cascade then amplifies through the rest of the document.
    // An EXISTING, already-settled H1 at size 20 is real evidence this
    // document's own H1 band IS size 20 -- deterministic, and usually more
    // correct than a fixed global ratio band.
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: true, confidence: 0.9, rationale: 'Reads as a genuine section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 6 body lines at size 11 dominate the median (~11); an existing H1 at
    // size 20 and a candidate /P at the SAME size 20 give ratio 20/11 ~=
    // 1.818 -- just OVER the 1.8 H2 cutoff, so the ratio path alone would
    // give level 2. The existing H1 at the identical size is the
    // cluster-match this test is checking overrides that to level 1.
    const lines: Line[] = [
      { text: 'Chapter One', y: 760, size: 20, zoneType: 'section-header' },
      { text: 'Executive Summary', y: 320, size: 20 },
      ...BODY_LINES,
    ];
    const { parsedPdf, buffer } = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf, buffer);

    expect(res).not.toBeNull();
    expect(res.value).toBe('1'); // NOT '2', which the ratio cutoff alone would give
    expect(res.rationale).toContain('matched to an existing H1');
  });
});
