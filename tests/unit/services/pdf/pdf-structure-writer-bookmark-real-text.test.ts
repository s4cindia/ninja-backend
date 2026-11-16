/**
 * Tests for the pdfjs-based real-text fallback in resolveRealHeadingInfo,
 * and the "nearest preceding heading" matching algorithm it enables in
 * regenerateGenericBookmarkTitles/generateBookmarksFromHeadings.
 *
 * Real incident (Karsaklian_189165_9781606497623.pdf, 2026-11-16): pdf-lib's
 * own extractTextFromStructElem (ActualText/Alt only) resolved ZERO of 69
 * real, normally-tagged headings on that file -- ordinary rendered-glyph
 * text was never reachable through that lookup at all. These tests use
 * REAL drawn text (page.drawText, no ActualText at all) wrapped in real
 * BDC/MCID marked content, so pdfjs genuinely has to decode it -- not a
 * mock standing in for "real text exists".
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFHexString, PDFDict, PDFRef, StandardFonts } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

interface HeadingSpec {
  pageIndex: number;
  y: number;
  text: string;
  level?: number;
}

/** Draws real text (no ActualText) on each spec's page, wraps each drawn
 *  text's own BT..ET block in real BDC/MCID marked content (one MCID per
 *  heading, scoped per page), and builds a struct element per heading
 *  bound to that MCID -- a genuinely pdfjs-decodable fixture, not a mock. */
async function buildDocWithRealHeadings(pageCount: number, specs: HeadingSpec[]): Promise<{ doc: PDFDocument; headingRefs: PDFRef[] }> {
  const src = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) src.addPage([400, 800]);
  const font = await src.embedFont(StandardFonts.Helvetica);

  const byPage = new Map<number, HeadingSpec[]>();
  for (const s of specs) {
    const list = byPage.get(s.pageIndex) ?? [];
    list.push(s);
    byPage.set(s.pageIndex, list);
  }
  for (const [pageIndex, pageSpecs] of byPage) {
    const page = src.getPage(pageIndex);
    for (const s of pageSpecs) {
      page.drawText(s.text, { x: 50, y: s.y, size: 14, font });
    }
  }

  // drawText only buffers operations into pdf-lib's own object model on
  // save() -- decodePageContent right after drawText (no save/reload
  // between) would see an empty content stream, same as every other
  // "build a real rendered fixture" test in this codebase.
  const doc = await PDFDocument.load(await src.save());

  const mcidBySpec = new Map<HeadingSpec, number>();
  for (const [pageIndex, pageSpecs] of byPage) {
    let content = decodePageContent(doc, pageIndex + 1) ?? '';
    let mcid = 0;
    // Wrap each BT..ET block in document order -- matches draw order above.
    content = content.replace(/BT[\s\S]*?ET/g, (block) => {
      const spec = pageSpecs[mcid];
      const assigned = mcid;
      mcid++;
      if (spec) mcidBySpec.set(spec, assigned);
      return `/P <</MCID ${assigned}>> BDC\n${block}\nEMC`;
    });
    writePageContent(doc, pageIndex + 1, content);
  }

  const headingRefs = specs.map(s => {
    const level = s.level ?? 1;
    const dict = doc.context.obj({
      S: PDFName.of(`H${level}`),
      Pg: doc.getPage(s.pageIndex).ref,
      K: mcidBySpec.get(s)!,
    });
    return doc.context.register(dict);
  });

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj(headingRefs) })
  );
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, headingRefs };
}

/** Adds a top-level generic bookmark. `top` (PDF user-space Y, bottom-up) is
 *  omitted entirely for a null-filled /XYZ destination (the shape
 *  generateBookmarksFromHeadings itself writes), or passed to test real
 *  Y-based disambiguation. */
function addGenericBookmark(doc: PDFDocument, pageIndex: number, top?: number): PDFRef {
  const page = doc.getPage(pageIndex);
  const dest = doc.context.obj([page.ref, PDFName.of('XYZ'), null, top ?? null, null]);
  const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText(`Section — p.${pageIndex + 1}`), Dest: dest }));
  const outlines = doc.context.obj({ Type: PDFName.of('Outlines'), First: itemRef, Last: itemRef }) as PDFDict;
  doc.catalog.set(PDFName.of('Outlines'), doc.context.register(outlines));
  return itemRef;
}

function titleOf(doc: PDFDocument, ref: PDFRef): string {
  const dict = doc.context.lookup(ref) as PDFDict;
  const title = dict.get(PDFName.of('Title'));
  return title instanceof PDFHexString ? title.decodeText() : '';
}

async function toParsedPdf(doc: PDFDocument): Promise<ParsedPDF> {
  const buffer = Buffer.from(await doc.save());
  return pdfParserService.parseBuffer(buffer, 'fixture.pdf');
}

describe('resolveRealHeadingInfo pdfjs fallback (via regenerateGenericBookmarkTitles)', () => {
  it('resolves real drawn text with no ActualText at all -- the actual Karsaklian failure mode', async () => {
    const { doc } = await buildDocWithRealHeadings(1, [{ pageIndex: 0, y: 700, text: 'Definitions from Armstrong and Kotler' }]);
    const bookmarkRef = addGenericBookmark(doc, 0);
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.regenerateGenericBookmarkTitles(doc, parsedPdf);
      expect(result.updated).toBe(1);
      expect(titleOf(doc, bookmarkRef)).toBe('Definitions from Armstrong and Kotler');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('inherits the governing heading from an earlier page when the bookmark\'s own page has no heading at all', async () => {
    const { doc } = await buildDocWithRealHeadings(2, [{ pageIndex: 0, y: 700, text: 'Chapter One: Origins' }]);
    // Bookmark targets page 2 (index 1), which has no heading of its own.
    const bookmarkRef = addGenericBookmark(doc, 1);
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.regenerateGenericBookmarkTitles(doc, parsedPdf);
      expect(result.updated).toBe(1);
      expect(titleOf(doc, bookmarkRef)).toBe('Chapter One: Origins');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('disambiguates two real-text headings on the SAME page using the bookmark\'s own real /XYZ top', async () => {
    const { doc } = await buildDocWithRealHeadings(1, [
      { pageIndex: 0, y: 700, text: 'Earlier Heading' },
      { pageIndex: 0, y: 600, text: 'Later Heading' },
    ]);
    // Target sits below BOTH headings (y=550, lower than both) -- the
    // nearer-above one ("Later Heading", drawn at y=600) should govern.
    const bookmarkRef = addGenericBookmark(doc, 0, 550);
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.regenerateGenericBookmarkTitles(doc, parsedPdf);
      expect(result.updated).toBe(1);
      expect(titleOf(doc, bookmarkRef)).toBe('Later Heading');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('bails on two real-text headings sharing a page when the bookmark has no real Y to disambiguate with (null-filled /XYZ, same shape this service itself generates)', async () => {
    const { doc } = await buildDocWithRealHeadings(1, [
      { pageIndex: 0, y: 700, text: 'Earlier Heading' },
      { pageIndex: 0, y: 600, text: 'Later Heading' },
    ]);
    const bookmarkRef = addGenericBookmark(doc, 0); // no top at all
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.regenerateGenericBookmarkTitles(doc, parsedPdf);
      expect(result.updated).toBe(0);
      expect(titleOf(doc, bookmarkRef)).toBe('Section — p.1');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });
});

describe('generateBookmarksFromHeadings pdfjs fallback', () => {
  it('uses real drawn heading text instead of the "Section -- p.N" placeholder when there is no ActualText', async () => {
    const { doc } = await buildDocWithRealHeadings(1, [{ pageIndex: 0, y: 700, text: 'The Marketing Mix' }]);
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.generateBookmarksFromHeadings(doc, parsedPdf);
      expect(result.generated).toBe(1);

      const outlinesRaw = doc.catalog.get(PDFName.of('Outlines'));
      const outlines = doc.context.lookup(outlinesRaw as PDFRef) as PDFDict;
      const firstRef = outlines.get(PDFName.of('First')) as PDFRef;
      expect(titleOf(doc, firstRef)).toBe('The Marketing Mix');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });
});
