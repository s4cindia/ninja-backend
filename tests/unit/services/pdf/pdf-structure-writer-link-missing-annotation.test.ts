/**
 * Regression coverage for fixLinkMissingAnnotation -- Slice 3 of the
 * LINK-MISSING-ANNOTATION fixer (Matterhorn 28-011). Wires slices 1-2's
 * pure content-stream splice (pdf-link-completeness-writer.ts) into a real
 * PDFDocument: creates the /Link annotation + structure element, splices it
 * into the enclosing /P's own /K, extends both ParentTree mechanisms.
 *
 * Fixture shape mirrors the REAL, live-confirmed Curiel_187961_CSHP.pdf
 * remediated copy exactly: the entire page's real content sits inside ONE
 * `/P <</MCID 0>> BDC BT ... ET EMC` span (see pdf-link-completeness-
 * writer.ts's own header comment for the full real-data breakdown).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

const URL = 'https://example.com/citation-url';
const PAGE_CONTENT = `/P <</MCID 0>> BDC BT\n[(Some citation text before)]TJ\n0 -1.5 Td\n[(${URL})]TJ\n0 -1.5 Td\n[(More citation text after)]TJ\nET EMC`;

function issueFor(pageNumber: number, url: string): AuditIssue {
  return {
    id: 'link-completeness-1',
    source: 'link-completeness-validator',
    severity: 'serious',
    code: 'LINK-MISSING-ANNOTATION',
    message: `Text reads as a hyperlink ("${url}") but has no underlying Link annotation`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    linkCompletenessData: { url },
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

/** Same flat /Nums-based /ParentTree helper pdf-structure-writer-artifact-swallows-content.test.ts already uses. */
function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/** Builds a one-page document whose entire page is one /P <</MCID 0>> span (the real shape). */
async function buildDoc(content: string): Promise<{ doc: PDFDocument; pRef: PDFRef; structTreeRootRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  writePageContent(doc, 1, content);

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef, structTreeRootRef };
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

describe('fixLinkMissingAnnotation', () => {
  it('creates a /Link annotation + structure element and splices the enclosing /P\'s /K into [original, Link, remainder]', async () => {
    const { doc, pRef, structTreeRootRef } = await buildDoc(PAGE_CONTENT);

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(true);
    expect(result.after).toContain(URL);

    // Enclosing /P's own /K: [0, linkRef, 1] -- original MCID untouched,
    // new /Link spliced in, remainder given a fresh MCID.
    const pK = kidsOf(doc, pRef);
    expect(pK).toHaveLength(3);
    expect(pK[0]).toBeInstanceOf(PDFNumber);
    expect((pK[0] as PDFNumber).asNumber()).toBe(0);
    const linkRef = pK[1] as PDFRef;
    expect(linkRef).toBeInstanceOf(PDFRef);
    expect(pK[2]).toBeInstanceOf(PDFNumber);
    expect((pK[2] as PDFNumber).asNumber()).toBe(2); // nextMcid started at 1 (0 already used) -> link=1, remainder=2

    const linkDict = doc.context.lookup(linkRef, PDFDict);
    expect(linkDict.get(PDFName.of('S'))?.toString()).toBe('/Link');
    expect(linkDict.get(PDFName.of('P'))?.toString()).toBe(pRef.toString());
    const linkK = linkDict.get(PDFName.of('K'));
    expect(linkK).toBeInstanceOf(PDFArray);
    const linkKArr = (linkK as PDFArray).asArray();
    expect(linkKArr).toHaveLength(2);
    expect((linkKArr[0] as PDFNumber).asNumber()).toBe(1); // linkMcid
    const objrRef = linkKArr[1] as PDFRef;
    const objrDict = doc.context.lookup(objrRef, PDFDict);
    expect(objrDict.get(PDFName.of('Type'))?.toString()).toBe('/OBJR');

    // The real annotation.
    const page = doc.getPage(0);
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
    expect(annots.size()).toBe(1);
    const annotRef = annots.get(0) as PDFRef;
    expect(objrDict.get(PDFName.of('Obj'))?.toString()).toBe(annotRef.toString());
    const annotDict = doc.context.lookup(annotRef, PDFDict);
    expect(annotDict.get(PDFName.of('Subtype'))?.toString()).toBe('/Link');
    expect(annotDict.get(PDFName.of('A')) instanceof PDFDict ? (annotDict.get(PDFName.of('A')) as PDFDict).get(PDFName.of('URI'))?.toString() : null).toBe(`(${URL})`);
    const rect = doc.context.lookup(annotDict.get(PDFName.of('Rect')), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    // boundingBox {x:100,y:300,width:150,height:10,pageHeight:792} -> [100, 792-300-10, 250, 792-300]
    expect(rect).toEqual([100, 482, 250, 492]);
    expect(annotDict.get(PDFName.of('StructParent'))).toBeInstanceOf(PDFNumber);

    // Content stream: URL's own run now sits inside a fresh /Link span;
    // the remainder sits inside a fresh /P span under its own new MCID.
    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain(`EMC /Link <</MCID 1>> BDC `);
    expect(fixedContent).toContain(`EMC /P <</MCID 2>> BDC `);
    expect(fixedContent).toContain(`(${URL})`);
    expect(fixedContent).toContain('More citation text after');

    // Both ParentTree mechanisms: page-level array now resolves MCID 1 ->
    // linkRef and MCID 2 -> pRef (the remainder's owner is still the
    // original /P), and the document-level standalone-object key space
    // has an entry for the annotation's own /StructParent resolving to
    // the SAME linkRef.
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const parentTree = doc.context.lookup(structRoot.get(PDFName.of('ParentTree')), PDFDict);
    const nums = doc.context.lookup(parentTree.get(PDFName.of('Nums')), PDFArray).asArray();
    const pageArr = doc.context.lookup(nums[1], PDFArray).asArray();
    expect((pageArr[1] as PDFRef).toString()).toBe(linkRef.toString());
    expect((pageArr[2] as PDFRef).toString()).toBe(pRef.toString());

    const structParentKey = (annotDict.get(PDFName.of('StructParent')) as PDFNumber).asNumber();
    let foundAnnotEntry: PDFRef | null = null;
    for (let i = 0; i < nums.length; i += 2) {
      if (nums[i] instanceof PDFNumber && (nums[i] as PDFNumber).asNumber() === structParentKey) {
        foundAnnotEntry = nums[i + 1] as PDFRef;
      }
    }
    expect(foundAnnotEntry?.toString()).toBe(linkRef.toString());
  });

  it('declines when the URL cannot be located as a clean operator run on the page', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, 'https://not-on-this-page.example.com'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not locate this URL');
  });

  it('declines when the enclosing content has no MCID of its own (a bare /Artifact)', async () => {
    const content = `/Artifact BMC BT\n[(before)]TJ\n0 -1.5 Td\n[(${URL})]TJ\n0 -1.5 Td\n[(after)]TJ\nET EMC`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(false);
    expect(result.error).toContain('untagged /Artifact span');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const issue = issueFor(1, URL);
    delete issue.boundingBox;
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no boundingBox');
  });

  it('rolls back content, /Annots, and the enclosing /K when a later ParentTree extension fails', async () => {
    // A legitimate, real document shape -- a HIERARCHICAL /Kids ParentTree
    // -- that resolveParentTreePageArray (used EARLY, to find the
    // enclosing /P) fully supports, but extendParentTree's own
    // resolveParentTreeNumsArray explicitly declines (same "unsupported
    // shape, bail rather than guess" convention every other caller in
    // this file already hits). This gives a REALISTIC late failure, after
    // /Annots, the content stream, and the enclosing /K have already been
    // mutated -- exactly the rollback path this test exists to exercise.
    const { doc, pRef, structTreeRootRef } = await buildDoc(PAGE_CONTENT);
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const pageArrRef = doc.context.register(doc.context.obj([pRef]));
    const leafNodeRef = doc.context.register(doc.context.obj({ Limits: [0, 0], Nums: [0, pageArrRef] }));
    const hierarchicalParentTree = doc.context.obj({ Kids: [leafNodeRef] });
    structRoot.set(PDFName.of('ParentTree'), hierarchicalParentTree);

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(false);
    expect(result.error).toContain('hierarchical');

    // Rollback must have restored all three mutated surfaces.
    const page = doc.getPage(0);
    expect(page.node.get(PDFName.of('Annots'))).toBeUndefined();
    const pDict = doc.context.lookup(pRef, PDFDict);
    const restoredK = pDict.get(PDFName.of('K'));
    expect(restoredK).toBeInstanceOf(PDFNumber);
    expect((restoredK as PDFNumber).asNumber()).toBe(0);
    expect(decodePageContent(doc, 1)).toBe(PAGE_CONTENT);
  });
});
