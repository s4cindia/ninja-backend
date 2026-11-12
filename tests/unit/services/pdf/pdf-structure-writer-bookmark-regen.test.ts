/**
 * Tests for PdfStructureWriterService.regenerateGenericBookmarkTitles --
 * confirmed real via all 67 bookmarks on Karsaklian_189165_9781606497623.pdf,
 * every single one literally "Section p.25" / "Section p.26" / etc. Unlike
 * generateBookmarksFromHeadings (builds a brand-new /Outlines tree from
 * scratch), this walks an EXISTING outline and only touches a bookmark's
 * /Title when it can unambiguously match it to a real-text heading.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFHexString, PDFDict, PDFRef } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

/** Minimal already-tagged doc: N pages, one H1 struct element per entry in
 *  `headings` (page index 0-based, real ActualText or null for "no real text"),
 *  no /RoleMap (literal /H1 tags). */
async function buildDocWithHeadings(
  pageCount: number,
  headings: Array<{ pageIndex: number; actualText: string | null }>,
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([400, 600]);
  const pages = doc.getPages();

  const headingRefs = headings.map(h => {
    const dict: Record<string, unknown> = { S: PDFName.of('H1'), Pg: pages[h.pageIndex].ref, K: 0 };
    if (h.actualText !== null) dict.ActualText = PDFHexString.fromText(h.actualText);
    return doc.context.register(doc.context.obj(dict));
  });

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj(headingRefs) })
  );
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return doc;
}

/** Adds a single top-level bookmark with the given title, pointed at pageIndex via a direct /Dest array. */
function addBookmark(doc: PDFDocument, title: string, pageIndex: number): PDFRef {
  const pages = doc.getPages();
  const dest = doc.context.obj([pages[pageIndex].ref, PDFName.of('XYZ'), null, null, null]);
  const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText(title), Dest: dest }));

  const outlinesRaw = doc.catalog.get(PDFName.of('Outlines'));
  let outlinesRef = outlinesRaw instanceof PDFRef ? outlinesRaw : undefined;
  let outlines: PDFDict;
  if (outlinesRef) {
    outlines = doc.context.lookup(outlinesRef) as PDFDict;
    const lastRef = outlines.get(PDFName.of('Last'));
    if (lastRef instanceof PDFRef) {
      const lastDict = doc.context.lookup(lastRef) as PDFDict;
      lastDict.set(PDFName.of('Next'), itemRef);
      const itemDict = doc.context.lookup(itemRef) as PDFDict;
      itemDict.set(PDFName.of('Prev'), lastRef);
    } else {
      outlines.set(PDFName.of('First'), itemRef);
    }
  } else {
    outlines = doc.context.obj({ Type: PDFName.of('Outlines') }) as PDFDict;
    outlinesRef = doc.context.register(outlines);
    outlines.set(PDFName.of('First'), itemRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }
  outlines.set(PDFName.of('Last'), itemRef);
  return itemRef;
}

function titleOf(doc: PDFDocument, ref: PDFRef): string {
  const dict = doc.context.lookup(ref) as PDFDict;
  const title = dict.get(PDFName.of('Title'));
  return title instanceof PDFHexString ? title.decodeText() : '';
}

describe('PdfStructureWriterService.regenerateGenericBookmarkTitles', () => {
  it('regenerates a generic bookmark title from its target page\'s real, unambiguous heading text', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: 'Chapter 3: Financial Risk Assessment' }]);
    const bookmarkRef = addBookmark(doc, 'Section p.1', 0);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(1);
    expect(titleOf(doc, bookmarkRef)).toBe('Chapter 3: Financial Risk Assessment');
  });

  it('does not touch a bookmark whose title is not actually generic', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: 'Chapter 3: Financial Risk Assessment' }]);
    const bookmarkRef = addBookmark(doc, 'My Custom Bookmark Title', 0);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
    expect(titleOf(doc, bookmarkRef)).toBe('My Custom Bookmark Title');
  });

  it('bails when two real-text headings share the same page (ambiguous)', async () => {
    const doc = await buildDocWithHeadings(1, [
      { pageIndex: 0, actualText: 'First Heading' },
      { pageIndex: 0, actualText: 'Second Heading' },
    ]);
    const bookmarkRef = addBookmark(doc, 'Section p.1', 0);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
    expect(titleOf(doc, bookmarkRef)).toBe('Section p.1');
  });

  it('bails when the target heading itself has no real (non-fallback) text', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: null }]);
    const bookmarkRef = addBookmark(doc, 'Section p.1', 0);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
    expect(titleOf(doc, bookmarkRef)).toBe('Section p.1');
  });

  it('never replaces a generic title with another placeholder-shaped heading text', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: 'Section 3' }]);
    const bookmarkRef = addBookmark(doc, 'Section p.1', 0);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
    expect(titleOf(doc, bookmarkRef)).toBe('Section p.1');
  });

  it('regenerates nested (child) bookmark titles too, not just top-level ones', async () => {
    const doc = await buildDocWithHeadings(2, [
      { pageIndex: 0, actualText: 'Part One' },
      { pageIndex: 1, actualText: 'Chapter One: Origins' },
    ]);
    const parentRef = addBookmark(doc, 'Section p.1', 0);
    const parentDict = doc.context.lookup(parentRef) as PDFDict;
    const pages = doc.getPages();
    const childDest = doc.context.obj([pages[1].ref, PDFName.of('XYZ'), null, null, null]);
    const childRef = doc.context.register(
      doc.context.obj({ Title: PDFHexString.fromText('Section p.2'), Dest: childDest, Parent: parentRef })
    );
    parentDict.set(PDFName.of('First'), childRef);
    parentDict.set(PDFName.of('Last'), childRef);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(2);
    expect(titleOf(doc, parentRef)).toBe('Part One');
    expect(titleOf(doc, childRef)).toBe('Chapter One: Origins');
  });

  it('resolves a page via /A GoTo /D, not just a direct /Dest array', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: 'Appendix: Glossary' }]);
    const pages = doc.getPages();
    const dest = doc.context.obj([pages[0].ref, PDFName.of('XYZ'), null, null, null]);
    const actionRef = doc.context.register(doc.context.obj({ S: PDFName.of('GoTo'), D: dest }));
    const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Section p.1'), A: actionRef }));
    const outlines = doc.context.obj({ Type: PDFName.of('Outlines'), First: itemRef, Last: itemRef }) as PDFDict;
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(outlines));

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(1);
    expect(titleOf(doc, itemRef)).toBe('Appendix: Glossary');
  });

  it('returns {updated: 0} and does not crash when there is no /Outlines at all', async () => {
    const doc = await buildDocWithHeadings(1, [{ pageIndex: 0, actualText: 'Chapter One' }]);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
  });

  it('returns {updated: 0} when there is no structure tree root at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = pdfStructureWriterService.regenerateGenericBookmarkTitles(doc);

    expect(result.updated).toBe(0);
  });
});
