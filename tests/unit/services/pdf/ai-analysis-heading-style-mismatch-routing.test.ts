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
 * Only geminiService.generateWithSchema is mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
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

async function buildTaggedDoc(lines: Line[]): Promise<ParsedPDF> {
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
  return pdfParserService.parseBuffer(buffer, 'heading-style-mismatch-routing-fixture.pdf');
}

const BODY_LINES: Line[] = [
  { text: 'The annual report summarizes revenue growth across every regional division for the fiscal year.', y: 680, size: 11 },
  { text: 'Operating margins improved due to disciplined cost management throughout the organization.', y: 630, size: 11 },
  { text: 'Customer retention remained strong despite increased competitive pressure in core markets.', y: 580, size: 11 },
  { text: 'The board approved a new capital allocation framework prioritizing shareholder returns.', y: 480, size: 11 },
  { text: 'International expansion continued with two new offices opened during the second half.', y: 430, size: 11 },
  { text: 'Supply chain investments reduced lead times and improved on-time delivery performance.', y: 380, size: 11 },
];

async function dispatchFirstIssue(parsedPdf: ParsedPDF) {
  const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
  expect(audit.issues).toHaveLength(1);
  const issue = audit.issues[0];
  const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
  const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());
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
    const parsedPdf = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf);

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('heading-promote-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.confidence).toBe(0.9);
    expect(['1', '2', '3']).toContain(res.value);
  });

  it('declines before ever calling the model when the font-size band is a common body-text style variant (cluster-size pre-filter)', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');

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
    const parsedPdf = await buildTaggedDoc(manyLines);
    const audit = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    expect(audit.issues.length).toBeGreaterThan(0);

    const issue = audit.issues[0];
    const parsed = { isTagged: true, pages: [], parsedPdf } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('declines when the model itself says this is not a heading', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { isHeading: false, confidence: 0.1, rationale: 'Reads as a decorative pull-quote, not a section title.' },
      usage: { promptTokens: 20, completionTokens: 10 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const parsedPdf = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf);

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
    const parsedPdf = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf);

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
    const parsedPdf = await buildTaggedDoc(lines);
    const { res } = await dispatchFirstIssue(parsedPdf);

    expect(res).not.toBeNull();
    expect(res.confidence).toBeCloseTo(0.8, 5); // 0.9 raw - 0.1 penalty
    expect(res.rationale).toContain('confidence reduced');
  });
});
