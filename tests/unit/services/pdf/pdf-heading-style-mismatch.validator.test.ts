/**
 * Tests for PDF Heading-Style Mismatch Validator (detect-only).
 *
 * Real S4 Carlisle manual QC finding this closes: a single paragraph
 * visually styled as a heading but tagged <TPT> (the document's generic
 * body-text style), among thousands of legitimate /P paragraphs sharing
 * that same style -- see pdf-heading-style-mismatch.validator.ts's own
 * header comment.
 *
 * Fixture strategy: a /RoleMap-level fixture (plain pdf-lib dict
 * construction, as pdf-rolemap-integrity.validator.test.ts uses) can't
 * exercise this validator -- it reads real per-content-ID font sizes via
 * pdfjs's own page.getStructTree() + getTextContent(), which requires a
 * genuinely correct /ParentTree + /StructParents + MCID-marked content
 * stream, not just a top-down /K tree. buildStructTreeFromZones (Seam-C's
 * own from-scratch tagger) already builds exactly that shape correctly and
 * is reused here purely as test-fixture machinery -- same pattern
 * pdf-modifier-alt-mcid.test.ts already uses for its own MCID-targeting
 * tests. zoneType 'paragraph' always maps to a literal /P tag (never
 * promoted by font size -- see canonical-to-tag.ts's ROLE_MAP), so a zone
 * drawn at heading size but tagged 'paragraph' faithfully reproduces the
 * real mistagged shape.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { pdfHeadingStyleMismatchValidator } from '../../../../src/services/pdf/validators/pdf-heading-style-mismatch.validator';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';

// Wide enough that even the deliberately-long paragraph below (used to
// exercise MAX_HEADING_CANDIDATE_CHARS) renders as a single, unbroken text
// run within the page -- pdfjs's own getTextContent() (which
// buildContentIdBBoxMap relies on, see this validator's own header comment)
// silently truncates a text item's extracted string once its drawn width
// would run past the page's right edge, which a realistic page width would
// do for a 240+ character single line at a heading-sized font. A real
// document never has text drawn off its own page edge, so this is purely a
// test-fixture accommodation, not a limitation of the validator itself.
const PAGE_WIDTH = 2400;
const PAGE_HEIGHT = 792;

interface Line {
  text: string;
  /** Baseline Y, PDF user-space (bottom-left origin) -- same convention page.drawText itself uses. */
  y: number;
  size: number;
}

/**
 * Converts a drawn text line's baseline position + font size into a
 * top-left-origin zone bbox generous enough to contain its whole glyph
 * extent, matching struct-tree-builder.ts's own device-space band
 * conversion (yTop = H - bbox.y, yBottom = H - (bbox.y + bbox.h)): centers
 * a band of height 1.5x the font size directly on the baseline.
 */
function zoneForLine(line: Line): OrderableZone {
  return {
    pageNumber: 1,
    zoneType: 'paragraph',
    bbox: {
      x: 40,
      y: PAGE_HEIGHT - line.y - line.size * 0.75,
      w: PAGE_WIDTH - 80,
      h: line.size * 1.5,
    },
  };
}

/** Builds a single-page, already-tagged PDF with one real /P struct element per line, each bound to its own real MCID-marked text run (real font size, real content). */
async function buildTaggedDoc(lines: Line[]): Promise<ParsedPDF> {
  const src = await PDFDocument.create();
  const page = src.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    page.drawText(line.text, { x: 60, y: line.y, size: line.size, font, color: rgb(0, 0, 0) });
  }
  // Save + reload so drawText's own operators are flushed into a real,
  // decodable content stream before buildStructTreeFromZones re-marks it.
  const doc = await PDFDocument.load(await src.save());

  const zones: OrderableZone[] = lines.map(zoneForLine);
  const built = buildStructTreeFromZones(doc, zones);
  expect(built.elements).toBeGreaterThan(0);
  expect(Object.keys(built.droppedZoneCounts)).toHaveLength(0);

  const buffer = Buffer.from(await doc.save());
  return pdfParserService.parseBuffer(buffer, 'heading-style-mismatch-fixture.pdf');
}

describe('PdfHeadingStyleMismatchValidator', () => {
  it(
    'flags a large, short /P element as a heading-style mismatch, while leaving ordinary body ' +
      'paragraphs, a short-but-normal-sized sentence, and a large-but-long paragraph alone',
    async () => {
      const lines: Line[] = [
        { text: 'Executive Summary', y: 740, size: 28 }, // the real S4 Carlisle shape: large + short, tagged /P
        {
          text: 'The annual report summarizes revenue growth across every regional division for the fiscal year.',
          y: 680,
          size: 11,
        },
        {
          text: 'Operating margins improved due to disciplined cost management throughout the organization.',
          y: 630,
          size: 11,
        },
        {
          text: 'Customer retention remained strong despite increased competitive pressure in core markets.',
          y: 580,
          size: 11,
        },
        { text: 'Agreed.', y: 530, size: 11 }, // short, but normal body font size -- must NOT be flagged
        {
          text: 'The board approved a new capital allocation framework prioritizing shareholder returns.',
          y: 480,
          size: 11,
        },
        {
          text: 'International expansion continued with two new offices opened during the second half.',
          y: 430,
          size: 11,
        },
        {
          text: 'Supply chain investments reduced lead times and improved on-time delivery performance.',
          y: 380,
          size: 11,
        },
        {
          // large font, but a genuine multi-sentence-length run -- must NOT be flagged (fails the
          // short-text side of the AND, exercising MAX_HEADING_CANDIDATE_CHARS independently of font size)
          text:
            'This particular paragraph is deliberately written to run on for quite a while, well past a ' +
            'typical heading length, specifically so this test can confirm that a large font size alone, ' +
            'without also being short, never gets flagged by this validator.',
          y: 330,
          size: 20,
        },
      ];

      const parsedPdf = await buildTaggedDoc(lines);
      const result = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);

      expect(result.metadata.paragraphsAnalyzed).toBe(9);
      expect(result.issues).toHaveLength(1);

      const issue = result.issues[0];
      expect(issue.code).toBe('HEADING-STYLE-MISMATCH');
      expect(issue.category).toBe('headings');
      expect(issue.severity).toBe('moderate');
      expect(issue.pageNumber).toBe(1);
      expect(issue.matterhornCheckpoint).toBe('01-006');
      expect(issue.message).toContain('Executive Summary');
      expect(issue.message).not.toContain('Agreed');
    },
  );

  it('does not flag anything when there are too few /P elements document-wide for a reliable median', async () => {
    const lines: Line[] = [
      { text: 'Executive Summary', y: 700, size: 28 },
      {
        text: 'This is a single ordinary body paragraph used only to give the document some real content.',
        y: 600,
        size: 11,
      },
    ];

    const parsedPdf = await buildTaggedDoc(lines);
    const result = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);

    // Only 2 /P elements total -- below MIN_SAMPLE_SIZE -- so even though one
    // of them is an extreme outlier, the validator bails rather than trust a
    // 2-sample median (same "bail rather than guess" convention as
    // findPrecedingColor / locateXObjectInvocation).
    expect(result.metadata.paragraphsAnalyzed).toBe(2);
    expect(result.issues).toHaveLength(0);
  });

  it("returns no issues for an untagged document (out of scope -- Seam-C's from-scratch tagger already handles heading-vs-body sizing at tagging time)", async () => {
    const fakeParsedPdf = { structure: { metadata: { isTagged: false } } } as unknown as ParsedPDF;

    const result = await pdfHeadingStyleMismatchValidator.validate(fakeParsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ paragraphsAnalyzed: 0, bodyMedianFontSize: 0, flagged: 0 });
  });
});
