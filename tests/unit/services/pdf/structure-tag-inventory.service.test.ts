/**
 * Coverage for structure-tag-inventory.service.ts -- the page-by-page
 * structure-element inventory backing the "Review structure tags" QC mode.
 * Fixture style (register a bare struct element directly in a real
 * StructTreeRoot, write raw content-stream ops via writePageContent) mirrors
 * pdf-figure-structtree.validator.test.ts's own "boundingBox attachment"
 * suite, which exercises the same underlying mcid-bounding-box.ts walk.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import {
  extractStructureTagsForPage,
  resolveElementRef,
  resolveElementPageNumber,
  buildPageByRef,
  isValidStructureTag,
  PDF_UA_STRUCTURE_TAGS,
} from '../../../../src/services/pdf/structure-tag-inventory.service';

async function makeDoc(pageCount = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  return doc;
}

describe('extractStructureTagsForPage', () => {
  it('returns a single element with its tag, page, elementId, and a real top-left-origin bbox', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const hDict = doc.context.obj({ S: PDFName.of('H1'), Pg: page.ref, K: 5 });
    const hRef = doc.context.register(hDict);
    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [hRef] });
    const docRef = doc.context.register(docNode);
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC');

    const result = extractStructureTagsForPage(doc, 1);

    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe('H1');
    expect(result[0].pageNumber).toBe(1);
    expect(result[0].elementId).toBe(`${hRef.objectNumber}-${hRef.generationNumber}`);
    // Device box x 100-170, y 500 (flat line). Page height 792 -> top y = 292.
    expect(result[0].bbox).toEqual({ x: 100, y: 292, width: 70, height: 0, pageWidth: 612, pageHeight: 792 });
  });

  it('aggregates a nested Table/TR/TH/TD subtree\'s bbox from its descendants, and chains parentElementId up the tree', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const thRef = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), K: 1 }));
    const tdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), K: 2 }));
    const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [thRef, tdRef] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [trRef] }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 10 10 cm 0 0 m 5 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 200 200 cm 0 0 m 5 0 l S Q EMC',
    );

    const result = extractStructureTagsForPage(doc, 1);
    const byTag = new Map(result.map(e => [e.tag, e]));

    expect(byTag.get('TH')!.bbox).toEqual({ x: 10, y: 782, width: 5, height: 0, pageWidth: 612, pageHeight: 792 });
    expect(byTag.get('TD')!.bbox).toEqual({ x: 200, y: 592, width: 5, height: 0, pageWidth: 612, pageHeight: 792 });
    expect(byTag.get('TR')!.bbox).toEqual({ x: 10, y: 592, width: 195, height: 190, pageWidth: 612, pageHeight: 792 });
    expect(byTag.get('Table')!.bbox).toEqual(byTag.get('TR')!.bbox);

    expect(byTag.get('TH')!.parentElementId).toBe(`${trRef.objectNumber}-${trRef.generationNumber}`);
    expect(byTag.get('TD')!.parentElementId).toBe(`${trRef.objectNumber}-${trRef.generationNumber}`);
    expect(byTag.get('TR')!.parentElementId).toBe(`${tableRef.objectNumber}-${tableRef.generationNumber}`);
    expect(byTag.get('Table')!.parentElementId).toBeUndefined();
  });

  it('omits an element whose subtree has no MCID content at all, rather than fabricating a bbox', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: page.ref }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [ref] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    expect(extractStructureTagsForPage(doc, 1)).toEqual([]);
  });

  it('returns an empty array when the document has no structure tree at all', async () => {
    const doc = await makeDoc();
    expect(extractStructureTagsForPage(doc, 1)).toEqual([]);
  });

  it('only returns elements that actually live on the requested page', async () => {
    const doc = await makeDoc(2);
    const page2 = doc.getPage(1);
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: page2.ref, K: 1 }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [ref] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
    writePageContent(doc, 2, '<</MCID 1>>BDC q 1 0 0 1 10 10 cm 0 0 m 5 0 l S Q EMC');

    expect(extractStructureTagsForPage(doc, 1)).toEqual([]);
    expect(extractStructureTagsForPage(doc, 2)).toHaveLength(1);
  });
});

describe('resolveElementRef', () => {
  it('resolves a valid elementId back to its PDFRef when it points at a real structure element', async () => {
    const doc = await makeDoc();
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('P') }));
    const id = `${ref.objectNumber}-${ref.generationNumber}`;

    const resolved = resolveElementRef(doc, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.objectNumber).toBe(ref.objectNumber);
  });

  it('returns null for a malformed elementId', async () => {
    const doc = await makeDoc();
    expect(resolveElementRef(doc, 'not-an-id')).toBeNull();
  });

  it('returns null when the ref does not point at a real structure element (no /S)', async () => {
    const doc = await makeDoc();
    const ref = doc.context.register(doc.context.obj({ Foo: PDFName.of('Bar') }));
    const id = `${ref.objectNumber}-${ref.generationNumber}`;

    expect(resolveElementRef(doc, id)).toBeNull();
  });

  it('returns null for a dangling reference (nothing registered at that object number)', async () => {
    const doc = await makeDoc();
    expect(resolveElementRef(doc, '999999-0')).toBeNull();
  });
});

describe('resolveElementPageNumber', () => {
  it('resolves directly from the element\'s own /Pg', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: page.ref }));

    expect(resolveElementPageNumber(doc, ref, buildPageByRef(doc))).toBe(1);
  });

  it('climbs the required /P parent chain when the element has no /Pg of its own', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const parentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref }));
    const childRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), P: parentRef }));

    expect(resolveElementPageNumber(doc, childRef, buildPageByRef(doc))).toBe(1);
  });

  it('returns null when no ancestor in the /P chain ever declares a /Pg', async () => {
    const doc = await makeDoc();
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('P') }));

    expect(resolveElementPageNumber(doc, ref, buildPageByRef(doc))).toBeNull();
  });
});

describe('isValidStructureTag', () => {
  it('accepts every tag in the canonical PDF/UA list', () => {
    for (const tag of PDF_UA_STRUCTURE_TAGS) expect(isValidStructureTag(tag)).toBe(true);
  });

  it('rejects an unrecognized tag', () => {
    expect(isValidStructureTag('NotARealTag')).toBe(false);
  });
});
