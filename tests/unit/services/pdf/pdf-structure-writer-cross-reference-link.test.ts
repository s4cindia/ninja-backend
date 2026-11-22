/**
 * Regression coverage for fixCrossReferenceLink/resolveCrossReferenceDestination
 * -- builds a real internal /Link (GoTo action) for a prose cross-reference
 * ("see Chapter 3", "see p. 45") ONLY when the target resolves unambiguously.
 * Reuses buildLinkAnnotationFix (the same splice/ParentTree/rollback core as
 * fixLinkMissingAnnotation) for the actual annotation-writing half; these
 * tests focus on the NEW half -- destination resolution and its "decline
 * rather than guess" gates.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFHexString, StandardFonts } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { writePageContent, decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

function crossRefIssue(
  pageNumber: number,
  crossReferenceData: NonNullable<AuditIssue['crossReferenceData']>,
): AuditIssue {
  return {
    id: 'cross-ref-1',
    source: 'link-completeness-validator',
    severity: 'moderate',
    code: 'CROSS-REFERENCE-MISSING-LINK',
    message: `Text reads as a cross-reference ("${crossReferenceData.fullText}") but has no underlying Link annotation to its target`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    crossReferenceData,
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a 2-page document: page 1 carries the cross-reference text in one
 * `/P <</MCID 0>>` span (same real shape as the LINK-MISSING-ANNOTATION
 * fixture), page 2 carries a heading struct element with real ActualText --
 * the resolution target. `headingText: null` builds a heading with no real
 * text at all (fallback case); omit `heading` entirely for "no heading on
 * any page."
 */
async function buildDoc(
  crossRefText: string,
  heading?: { text: string | null; level?: number } | { text: string | null; level?: number }[],
): Promise<{ doc: PDFDocument; pRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  page1.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  const page2 = doc.addPage([612, 792]);
  // The cross-reference text is embedded mid-sentence (surrounded by other
  // prose in the SAME text-show operand), so this always needs the same-
  // operand splitter (findUrlSubstringRun), not the "isolated in its own
  // operand" clean path -- that splitter's own font-safety guard requires a
  // resolvable, simple font at the cut point (same real requirement
  // pdf-structure-writer-link-missing-annotation.test.ts's own "falls back
  // to the same-operand splitter" fixture registers).
  writePageContent(doc, 1, `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(For more detail, ${crossRefText} of this document.)Tj\nET EMC`);
  const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
  page1.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page1.ref, K: 0 }));

  const headings = heading ? (Array.isArray(heading) ? heading : [heading]) : [];
  const headingRefs = headings.map(h => {
    const dict: Record<string, unknown> = { S: PDFName.of(`H${h.level ?? 1}`), Pg: page2.ref, K: 0 };
    if (h.text !== null) dict.ActualText = PDFHexString.fromText(h.text);
    return doc.context.register(doc.context.obj(dict));
  });

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef, ...headingRefs] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef };
}

describe('fixCrossReferenceLink', () => {
  it('resolves and links "see Chapter N" to its single matching real-text heading', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(true);
    expect(result.after).toContain('see Chapter 3');
  });

  it('declines when two headings match the same "Chapter N" reference (ambiguous)', async () => {
    const { doc } = await buildDoc('see Chapter 3', [
      { text: 'Chapter 3: Origins' },
      { text: 'Chapter 3: A Different Section' },
    ]);

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unambiguously');
  });

  // Real, live-confirmed collision on Karsaklian_189165_9781606497623.pdf:
  // "CHAPTER 1" (a real heading) and "CHAPTER 10" (a DIFFERENT real
  // heading) both matched a "see Chapter 1" reference under a bare
  // .startsWith("chapter 1") check -- "chapter 10" is itself a string-
  // prefix match for "chapter 1", so the fix wrongly declined this as
  // ambiguous even though only one heading was ever the real target.
  it('matches "Chapter 1" exactly, not as a false-ambiguous prefix of "Chapter 10"', async () => {
    const { doc } = await buildDoc('see Chapter 1', [
      { text: 'Chapter 1: Introduction' },
      { text: 'Chapter 10: Conclusion' },
    ]);

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '1', fullText: 'see Chapter 1' })
    );

    expect(result.success).toBe(true);
  });

  it('declines when no heading matches the reference at all', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 5: Unrelated Topic' });

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
  });

  it('declines when the matching heading itself has no real (non-fallback) text', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: null });

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
  });

  it('resolves "see Section N" the same way as "see Chapter N"', async () => {
    const { doc } = await buildDoc('see Section 2', { text: 'Section 2: Methodology', level: 2 });

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'section', number: '2', fullText: 'see Section 2' })
    );

    expect(result.success).toBe(true);
  });

  it('declines "see Figure N" / "see Table N" -- no resolution path exists for these keywords', async () => {
    const { doc } = await buildDoc('see Figure 2', { text: 'Chapter 3: Financial Risk Assessment' });

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'figure', number: '2', fullText: 'see Figure 2' })
    );

    expect(result.success).toBe(false);
  });

  it('resolves "see page NN" via real /PageLabels when exactly one page matches', async () => {
    const { doc } = await buildDoc('see page 45');
    // Page index 0 (page 1, where the cross-reference text itself lives)
    // prints as "1", page index 1 (page 2) restarts at "45" -- so "45"
    // unambiguously means page index 1.
    const pageLabelsRef = doc.context.register(doc.context.obj({
      Nums: [
        0, doc.context.obj({ S: PDFName.of('D'), St: 1 }),
        1, doc.context.obj({ S: PDFName.of('D'), St: 45 }),
      ],
    }));
    doc.catalog.set(PDFName.of('PageLabels'), pageLabelsRef);

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'page', number: '45', fullText: 'see page 45' })
    );

    expect(result.success).toBe(true);
  });

  it('declines "see page NN" when the document has no /PageLabels at all', async () => {
    const { doc } = await buildDoc('see page 45');

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'page', number: '45', fullText: 'see page 45' })
    );

    expect(result.success).toBe(false);
  });

  it('declines cleanly when the issue has no crossReferenceData', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });
    const issue = crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' });
    delete (issue as { crossReferenceData?: unknown }).crossReferenceData;

    const result = await pdfStructureWriterService.fixCrossReferenceLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('crossReferenceData');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });
    const issue = crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' });
    delete (issue as { boundingBox?: unknown }).boundingBox;

    const result = await pdfStructureWriterService.fixCrossReferenceLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boundingBox');
  });
});

/**
 * Real incident (Whiting_186772_E9778, confirmed live): this document's own
 * real H1-H4 headings carry no /ActualText or /Alt at all (ordinary
 * InDesign-exported rendered-glyph text) -- the SAME gap
 * pdf-structure-writer-bookmark-real-text.test.ts already covers for
 * generateBookmarksFromHeadings/regenerateGenericBookmarkTitles, just hitting
 * resolveCrossReferenceDestination's own, separate direct-extraction call
 * instead. Every one of this document's 55 real "in chapter N" cross-
 * references declined with zero candidate matches, not genuine ambiguity.
 * These tests use REAL drawn text (page.drawText, no ActualText at all)
 * wrapped in real BDC/MCID marked content, so pdfjs genuinely has to decode
 * it -- not a mock standing in for "real text exists" (same fixture shape as
 * pdf-structure-writer-bookmark-real-text.test.ts's own buildDocWithRealHeadings).
 */
describe('fixCrossReferenceLink pdfjs fallback', () => {
  async function buildDocWithRealHeading(crossRefText: string, headingText: string, level = 1): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    const page1 = src.addPage([612, 792]);
    page1.node.set(PDFName.of('StructParents'), src.context.obj(0));
    const page2 = src.addPage([612, 792]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page2.drawText(headingText, { x: 50, y: 700, size: 14, font });

    // drawText only buffers operations into pdf-lib's own object model on
    // save() -- decodePageContent right after drawText (no save/reload
    // between) would see an empty content stream.
    const doc = await PDFDocument.load(await src.save());

    writePageContent(doc, 1, `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(For more detail, ${crossRefText} of this document.)Tj\nET EMC`);
    const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
    doc.getPage(0).node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));

    let page2Content = decodePageContent(doc, 2) ?? '';
    page2Content = page2Content.replace(/BT[\s\S]*?ET/, (block) => `/P <</MCID 0>> BDC\n${block}\nEMC`);
    writePageContent(doc, 2, page2Content);

    const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: doc.getPage(0).ref, K: 0 }));
    const headingRef = doc.context.register(doc.context.obj({ S: PDFName.of(`H${level}`), Pg: doc.getPage(1).ref, K: 0 }));
    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef, headingRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    const pageArr = doc.context.obj([pRef]);
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), doc.context.obj({ Nums: [0, pageArr] }));

    return doc;
  }

  async function toParsedPdf(doc: PDFDocument): Promise<ParsedPDF> {
    const buffer = Buffer.from(await doc.save());
    return pdfParserService.parseBuffer(buffer, 'fixture.pdf');
  }

  it('resolves "see Chapter N" via the pdfjs fallback when the heading has no ActualText at all', async () => {
    const doc = await buildDocWithRealHeading('see Chapter 3', 'Chapter 3: Financial Risk Assessment');
    const parsedPdf = await toParsedPdf(doc);

    try {
      const result = await pdfStructureWriterService.fixCrossReferenceLink(
        doc,
        crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' }),
        parsedPdf,
      );

      expect(result.success).toBe(true);
      expect(result.after).toContain('see Chapter 3');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('still declines (not a crash) when no parsedPdf is passed, even though the heading has real drawn text', async () => {
    const doc = await buildDocWithRealHeading('see Chapter 3', 'Chapter 3: Financial Risk Assessment');

    const result = await pdfStructureWriterService.fixCrossReferenceLink(
      doc,
      crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' }),
    );

    expect(result.success).toBe(false);
  });
});
