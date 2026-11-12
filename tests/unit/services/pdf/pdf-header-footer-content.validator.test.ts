/**
 * Tests for PDF Header/Footer Tagged-As-Content Validator (DETECT-ONLY,
 * Matterhorn 01-001). Confirmed real via an S4 Carlisle manual QC report:
 * page-repeating decorative text (a running header/title, or a plain
 * running page number) sometimes tagged as real content instead of
 * /Artifact.
 *
 * Builds real multi-page PDFs via pdf-lib (drawText at known positions)
 * and runs them through the REAL pdfComprehensiveParserService, rather
 * than hand-constructing a PdfParseResult -- this validator's own correct
 * behavior depends on a real, easy-to-get-backwards Y-axis conversion
 * between PdfTextContent's top-left-origin position and
 * artifact-marker.ts's bottom-left-origin bands (see the validator's own
 * header comment, adaptation 1), which a hand-mocked object could too
 * easily paper over without ever exercising the real conversion.
 *
 * Page size is a constant [400, 800] throughout, so the header band (top
 * 12%) is y in [704, 800] and the footer band (bottom 10%) is y in [0, 80]
 * in pdf-lib's own (PDF-native, bottom-left-origin) drawText coordinates --
 * the same space these tests place text in.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { pdfHeaderFooterContentValidator } from '../../../../src/services/pdf/validators/pdf-header-footer-content.validator';
import { pdfComprehensiveParserService, PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 800;
// Comfortably inside the footer band ([0, 80]) and header band ([704, 800]).
const FOOTER_Y = 30;
const HEADER_Y = 770;

async function parseAndRun(doc: PDFDocument) {
  const buffer = Buffer.from(await doc.save());
  const parsed: PdfParseResult = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');
  try {
    return await pdfHeaderFooterContentValidator.validate(parsed);
  } finally {
    if (parsed.parsedPdf) await pdfParserService.close(parsed.parsedPdf);
  }
}

function addPage(doc: PDFDocument): PDFPage {
  return doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
}

function draw(page: PDFPage, text: string, x: number, y: number, font: PDFFont): void {
  page.drawText(text, { x, y, size: 10, font, color: rgb(0, 0, 0) });
}

/** Locates the one BT...ET block whose text matrix matches (x, y) exactly -- same technique already established by pdf-contrast-artifact-exclusion.test.ts -- and wraps it in /Artifact BMC...EMC. */
function wrapRunInArtifact(doc: PDFDocument, pageNumber: number, x: number, y: number): void {
  const raw = decodePageContent(doc, pageNumber);
  if (raw === null) throw new Error(`Could not decode content for page ${pageNumber}`);
  const marker = `1 0 0 1 ${x} ${y} Tm`;
  const markerPos = raw.indexOf(marker);
  if (markerPos === -1) throw new Error(`Tm marker "${marker}" not found on page ${pageNumber}`);
  const start = raw.lastIndexOf('BT', markerPos);
  const end = raw.indexOf('ET', markerPos) + 'ET'.length;
  const wrapped = `${raw.slice(0, start)}/Artifact BMC\n${raw.slice(start, end)}\nEMC\n${raw.slice(end)}`;
  writePageContent(doc, pageNumber, wrapped);
}

describe('PdfHeaderFooterContentValidator', () => {
  it('flags a footer recurring on exactly the 5-page absolute minimum, but not one on 4 pages (same 8-page doc, 50% ratio either way)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 8; i++) {
      const page = addPage(doc);
      if (i < 5) draw(page, 'Recurring Footer', 60, FOOTER_Y, font);
      if (i < 4) draw(page, 'Four Pager', 250, FOOTER_Y, font);
    }

    const issues = await parseAndRun(doc);

    const recurring = issues.find((i) => i.element === 'recurring footer');
    expect(recurring).toBeDefined();
    expect(recurring?.code).toBe('HEADER-FOOTER-TAGGED-AS-CONTENT');
    expect(recurring?.category).toBe('structure');
    expect(recurring?.severity).toBe('minor');
    expect(recurring?.matterhornCheckpoint).toBe('01-001');
    expect(recurring?.wcagCriteria).toEqual(['1.3.1']);
    expect(recurring?.context).toBe('Pages: 1, 2, 3, 4, 5');
    expect(recurring?.message).toContain('5 of 8 pages');

    // 4/8 = 50% (meets the ratio) but only 4 pages (fails the >=5 absolute minimum).
    expect(issues.find((i) => i.element === 'four pager')).toBeUndefined();
  });

  it('flags a footer recurring on exactly the 50% ratio minimum, but not one on 5-of-12 pages (both >=5 pages absolute)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 12; i++) {
      const page = addPage(doc);
      if (i < 6) draw(page, 'Half Match', 60, FOOTER_Y, font);
      if (i < 5) draw(page, 'Five Of Twelve', 250, FOOTER_Y, font);
    }

    const issues = await parseAndRun(doc);

    // 6/12 = 50% exactly, and 6 >= 5 -- passes both conditions.
    expect(issues.find((i) => i.element === 'half match')).toBeDefined();
    // 5 >= 5 (absolute minimum met) but 5/12 ≈ 41.7% (fails the 50% ratio).
    expect(issues.find((i) => i.element === 'five of twelve')).toBeUndefined();
  });

  it('catches a plain running page number (digit-collapse case) with the [page-number pattern] wording', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 10; i++) {
      const page = addPage(doc);
      draw(page, String(i + 1), 150, FOOTER_Y, font);
    }

    const issues = await parseAndRun(doc);

    expect(issues).toHaveLength(1);
    expect(issues[0].element).toBe('#');
    expect(issues[0].message).toContain('[page-number pattern]');
    expect(issues[0].context).toBe('Pages: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10');
  });

  it('does not flag ordinary, non-repeating text that happens to sit in the header band', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
    for (const word of words) {
      const page = addPage(doc);
      draw(page, word, 60, HEADER_Y, font);
    }

    const issues = await parseAndRun(doc);

    expect(issues).toHaveLength(0);
  });

  it('does not flag text already wrapped in /Artifact, while still flagging an untouched recurring sibling', async () => {
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 6; i++) {
      const page = addPage(src);
      draw(page, 'Confidential Draft', 60, FOOTER_Y, font);
      draw(page, 'Running Footer Two', 250, FOOTER_Y, font);
    }
    const doc = await PDFDocument.load(await src.save());
    for (let pageNumber = 1; pageNumber <= 6; pageNumber++) {
      wrapRunInArtifact(doc, pageNumber, 60, FOOTER_Y);
    }

    const issues = await parseAndRun(doc);

    expect(issues.find((i) => i.element === 'confidential draft')).toBeUndefined();
    const sibling = issues.find((i) => i.element === 'running footer two');
    expect(sibling).toBeDefined();
    expect(sibling?.context).toBe('Pages: 1, 2, 3, 4, 5, 6');
  });
});
