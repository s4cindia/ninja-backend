/**
 * Tests for PdfTocValidator -- S4 Carlisle manual QC, Round 2, item #4.
 *
 * Builds a small real pdf-lib document whose TOC page has the exact real
 * shape found on Karsaklian_189165_9781606497623.pdf: each row is three
 * flat sibling /P bare-MCID spans (title, dot-leader, trailing page-number
 * label), tagged as plain /P (never /TOC/TOCI), with zero Link annotations
 * anywhere -- see toc-entry-extractor.ts and pdf-toc.validator.ts's own
 * header comments for the full real-document background.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict } from 'pdf-lib';
import { pdfTocValidator } from '../../../../src/services/pdf/validators/pdf-toc.validator';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { PdfParseResult, PdfPage, PdfLink } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// Labels deliberately NOT "2"/"3" -- pdfParserService.extractPageLabels
// treats a /PageLabels dict that reproduces the trivial default 1,2,3...
// numbering as meaningless (indistinguishable from no /PageLabels at all)
// and returns undefined for it. Starting the document's real page-label
// sequence at 11 (so page 2 -> "12", page 3 -> "13") keeps it genuinely
// non-default, same as the real Karsaklian document's own roman-then-
// restarted-decimal split.
function tocPageContent(): string {
  return [
    '/P <</MCID 0>> BDC BT 10.5 0 0 10.5 84 513 Tm (Chapter One)Tj ET EMC',
    '/P <</MCID 1>> BDC BT 10.5 0 0 10.5 200 513 Tm (..........)Tj ET EMC',
    '/P <</MCID 2>> BDC BT 10.5 0 0 10.5 370 513 Tm (12)Tj ET EMC',
    '/P <</MCID 3>> BDC BT 10.5 0 0 10.5 84 498 Tm (Chapter Two)Tj ET EMC',
    '/P <</MCID 4>> BDC BT 10.5 0 0 10.5 200 498 Tm (..........)Tj ET EMC',
    '/P <</MCID 5>> BDC BT 10.5 0 0 10.5 370 498 Tm (13)Tj ET EMC',
  ].join('\n');
}

function tocPageTextContent(): PdfPage['content'] {
  // Matches TocDetector's own scoring inputs (dot-leaders + a high ratio of
  // lines ending in a 1-4 digit number) closely enough to clear its
  // HIGH_CONFIDENCE heuristic threshold without needing the Haiku fallback.
  return [
    { text: 'Chapter One .......... 12', position: { x: 84, y: 513, width: 300, height: 10.5 } },
    { text: 'Chapter Two .......... 13', position: { x: 84, y: 498, width: 300, height: 10.5 } },
  ];
}

interface BuildOptions {
  /** Add an extra /Table struct element anchored to the TOC page (the
   *  "TOC mistagged as Table" shape smart-triage's own TOC-TAGGING
   *  reclassification already owns). */
  withTableTag?: boolean;
  /** Add an extra /TOC struct element anchored to the TOC page (already
   *  correctly tagged -- nothing to flag). */
  withTocTag?: boolean;
}

async function buildDoc(opts: BuildOptions = {}): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const tocPage = doc.addPage([612, 792]);
  tocPage.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  doc.addPage([612, 792]); // page 2 -- GoTo target for label "2"
  doc.addPage([612, 792]); // page 3 -- GoTo target for label "3"

  writePageContent(doc, 1, tocPageContent());

  const refs: PDFRef[] = [];
  for (let mcid = 0; mcid < 6; mcid++) {
    refs.push(doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: tocPage.ref, K: mcid })));
  }
  if (opts.withTableTag) {
    refs.push(doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Table'), Pg: tocPage.ref, K: 0 })));
  }
  if (opts.withTocTag) {
    refs.push(doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TOC'), Pg: tocPage.ref, K: 0 })));
  }

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: refs }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  const pageArr = doc.context.obj(refs);
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), doc.context.obj({ Nums: [0, pageArr] }));

  // Decimal page labels starting at 11 -- page 1 (the TOC page itself) =
  // "11", page 2 = "12", page 3 = "13". Every real TOC entry's own
  // trailing label matches a DIFFERENT page's real printed label exactly
  // once (and the sequence is non-default, so extractPageLabels doesn't
  // discard it -- see tocPageContent's own doc comment).
  const pageLabelsRef = doc.context.register(doc.context.obj({ Nums: [0, doc.context.obj({ S: PDFName.of('D'), St: 11 })] }));
  doc.catalog.set(PDFName.of('PageLabels'), pageLabelsRef);

  return doc;
}

function buildParsed(doc: PDFDocument, tocLinks: PdfLink[] = []): PdfParseResult {
  const blankPage = (pageNumber: number): PdfPage => ({
    pageNumber, width: 612, height: 792, rotation: 0,
    content: [], images: [], links: [], formFields: [], headings: [], tables: [], lists: [],
  });

  const tocPage: PdfPage = {
    pageNumber: 1, width: 612, height: 792, rotation: 0,
    content: tocPageTextContent(), images: [], links: tocLinks, formFields: [], headings: [], tables: [], lists: [],
  };

  return {
    metadata: {
      pdfVersion: '1.7', isEncrypted: false, isLinearized: false, isTagged: true,
      hasOutline: false, hasAcroForm: false, hasXFA: false, pageCount: 3, hasStructureTree: true,
    },
    pages: [tocPage, blankPage(2), blankPage(3)],
    isTagged: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedPdf: { pdfLibDoc: doc, structure: { outline: [] } } as any,
  };
}

describe('PdfTocValidator', () => {
  it('flags TOC-STRUCTURE-MISSING once for a detected TOC page tagged with plain /P (never /TOC/TOCI)', async () => {
    const doc = await buildDoc();
    const issues = await pdfTocValidator.validate(buildParsed(doc));

    const structureIssues = issues.filter(i => i.code === 'TOC-STRUCTURE-MISSING');
    expect(structureIssues).toHaveLength(1);
    expect(structureIssues[0].pageNumber).toBe(1);
  });

  it('does not flag TOC-STRUCTURE-MISSING when the page already has a real /TOC element', async () => {
    const doc = await buildDoc({ withTocTag: true });
    const issues = await pdfTocValidator.validate(buildParsed(doc));

    expect(issues.find(i => i.code === 'TOC-STRUCTURE-MISSING')).toBeUndefined();
  });

  it('does not flag TOC-STRUCTURE-MISSING when the page is tagged as /Table -- already owned by smart-triage\'s own TOC-TAGGING reclassification', async () => {
    const doc = await buildDoc({ withTableTag: true });
    const issues = await pdfTocValidator.validate(buildParsed(doc));

    expect(issues.find(i => i.code === 'TOC-STRUCTURE-MISSING')).toBeUndefined();
  });

  it('flags TOC-LINK-MISSING for each entry whose label resolves to exactly one real page, carrying the resolved MCID/target', async () => {
    const doc = await buildDoc();
    const issues = await pdfTocValidator.validate(buildParsed(doc));

    const linkIssues = issues.filter(i => i.code === 'TOC-LINK-MISSING');
    expect(linkIssues).toHaveLength(2);

    const row1 = linkIssues.find(i => i.tocLinkData?.label === '12');
    expect(row1).toBeTruthy();
    expect(row1!.tocLinkData!.mcid).toBe(2);
    expect(row1!.tocLinkData!.targetPageIndex).toBe(1); // page 2, 0-based index 1
    expect(row1!.tocLinkData!.entryText).toContain('Chapter One');

    const row2 = linkIssues.find(i => i.tocLinkData?.label === '13');
    expect(row2).toBeTruthy();
    expect(row2!.tocLinkData!.mcid).toBe(5);
    expect(row2!.tocLinkData!.targetPageIndex).toBe(2); // page 3, 0-based index 2
  });

  it('every TOC-LINK-MISSING issue carries a non-degenerate boundingBox (real Rect placement needs non-zero width/height)', async () => {
    const doc = await buildDoc();
    const issues = await pdfTocValidator.validate(buildParsed(doc));

    for (const issue of issues.filter(i => i.code === 'TOC-LINK-MISSING')) {
      expect(issue.boundingBox!.width).toBeGreaterThan(0);
      expect(issue.boundingBox!.height).toBeGreaterThan(0);
    }
  });

  it('does not re-flag an entry that already has a real Link annotation covering it (e.g. a prior fix, seen on re-audit)', async () => {
    const doc = await buildDoc();
    // Row 1's label ("12") sits at content-stream Tm (370, 513) with
    // fontSize 10.5 -- same geometry rowBoundingBox derives, converted to
    // the validator's own top-left-origin convention: y = 792 - 513 - 10.5.
    const existingLink: PdfLink = {
      text: '12', position: { x: 370, y: 792 - 513 - 10.5, width: 20, height: 10.5 }, hasDescriptiveText: true,
    };

    const issues = await pdfTocValidator.validate(buildParsed(doc, [existingLink]));
    const linkIssues = issues.filter(i => i.code === 'TOC-LINK-MISSING');

    expect(linkIssues).toHaveLength(1);
    expect(linkIssues[0].tocLinkData?.label).toBe('13');
  });

  it('declines (does not flag) a label that does not resolve to exactly one real page', async () => {
    const doc = await PDFDocument.create();
    const tocPage = doc.addPage([612, 792]);
    tocPage.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    doc.addPage([612, 792]);
    writePageContent(doc, 1, [
      '/P <</MCID 0>> BDC BT 10.5 0 0 10.5 84 513 Tm (Orphan Entry)Tj ET EMC',
      '/P <</MCID 1>> BDC BT 10.5 0 0 10.5 200 513 Tm (..........)Tj ET EMC',
      '/P <</MCID 2>> BDC BT 10.5 0 0 10.5 370 513 Tm (99)Tj ET EMC',
    ].join('\n'));
    const ref0 = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: tocPage.ref, K: 2 }));
    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [ref0] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), doc.context.obj({ Nums: [0, doc.context.obj([ref0])] }));
    // No /PageLabels at all -- "99" cannot resolve to anything.

    const parsed = buildParsed(doc);
    parsed.metadata.pageCount = 2;
    parsed.pages = [parsed.pages[0], parsed.pages[1]];
    const issues = await pdfTocValidator.validate(parsed);

    expect(issues.filter(i => i.code === 'TOC-LINK-MISSING')).toHaveLength(0);
  });

  it('returns no issues at all when no TOC page is detected', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsed = buildParsed(doc);
    parsed.pages = [{ ...parsed.pages[0], content: [{ text: 'Just an ordinary paragraph of body prose.', position: { x: 84, y: 513, width: 300, height: 10.5 } }] }];
    parsed.metadata.pageCount = 1;

    const issues = await pdfTocValidator.validate(parsed);
    expect(issues).toHaveLength(0);
  });
});
