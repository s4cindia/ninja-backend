/**
 * Regression coverage for retagPlacedPdfAsFigure -- fixes Adobe InDesign's
 * own non-standard `/PlacedPDF` marked-content tag for placed vector art.
 * Confirmed live on Farrar_2E_Comp_188910.pdf: 56 of 124 pages, 77
 * top-level spans, and in EVERY instance the tag's own properties
 * reference resolves to `<< /Metadata ... >>`, never an `/MCID` -- so this
 * content has no possible connection to the structure tree despite
 * looking tagged. See pdf-artifact-tagger.ts's findPlacedPdfSpans for the
 * full forensic trail.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: `issue-page-${pageNumber ?? 'none'}`,
    source: 'pdf-structure',
    severity: 'serious',
    code: 'PLACEDPDF-NOT-TAGGED',
    message: '/PlacedPDF region(s) carry no real MCID and are unreachable from the structure tree',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    category: 'structure',
    pageNumber,
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

async function buildDoc(content: string): Promise<{
  doc: PDFDocument;
  flowParentRef: PDFRef;
  leftRef: PDFRef;
  rightRef: PDFRef;
}> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  writePageContent(doc, 1, content);

  const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
  const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
  const flowParentRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, rightRef] }),
  );
  doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
  doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef]);

  return { doc, flowParentRef, leftRef, rightRef };
}

const PLACED_ART = '/PlacedPDF /MC0 BDC\n0 0 m\n10 10 l\n10 0 l\nh\nf\nEMC\n';

describe('retagPlacedPdfAsFigure', () => {
  it('retags a /PlacedPDF span as a /Figure with a real MCID, wired into the document flow', async () => {
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n` +
      PLACED_ART +
      `/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc, flowParentRef, leftRef, rightRef } = await buildDoc(content);

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));

    expect(result.success).toBe(true);
    expect(result.after).toContain('1 span(s) retagged as /Figure');

    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(3);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[2].objectNumber).toBe(rightRef.objectNumber);
    const figureRef = kids[1];
    const figureDict = doc.context.lookup(figureRef, PDFDict);
    expect(figureDict.get(PDFName.of('S'))?.toString()).toBe('/Figure');
    expect(figureDict.get(PDFName.of('P'))?.toString()).toBe(flowParentRef.toString());
    expect(figureDict.get(PDFName.of('Alt'))).toBeUndefined();

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('/Figure <</MCID 2>> BDC');
    expect(fixedContent).not.toContain('/PlacedPDF');
    // The real drawing bytes are untouched, still present verbatim, and
    // the pre-existing closing EMC now correctly closes the new /Figure.
    expect(fixedContent).toContain('0 0 m\n10 10 l\n10 0 l\nh\nf\nEMC');
  });

  it('retags multiple /PlacedPDF spans on the same page with sequential MCIDs', async () => {
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n` +
      PLACED_ART +
      `/P <</MCID 1 >>BDC\n(Middle)Tj\nEMC\n` +
      PLACED_ART +
      `/P <</MCID 2 >>BDC\n(After)Tj\nEMC\n`;
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, content);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const midRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 2 }));
    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, midRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(midRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, midRef, rightRef]);

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));
    expect(result.success).toBe(true);
    expect(result.after).toContain('2 span(s) retagged');

    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(5);
    const sTypes = kids.map((k) => doc.context.lookup(k, PDFDict).get(PDFName.of('S'))?.toString());
    expect(sTypes).toEqual(['/P', '/Figure', '/P', '/Figure', '/P']);
  });

  it('declines cleanly when the issue has no pageNumber', async () => {
    const { doc } = await buildDoc(PLACED_ART);
    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(undefined));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no pageNumber');
  });

  it('declines cleanly when the page has no /PlacedPDF span left (already fixed or moved)', async () => {
    const { doc } = await buildDoc('/P <</MCID 0 >>BDC\n(Just a normal page)Tj\nEMC\n');
    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No top-level /PlacedPDF spans found');
  });

  it('declines when neither MCID neighbor resolves to a usable document-flow parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, PLACED_ART);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, []); // matches the live whole-page-is-one-span case

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no usable tagged neighbor');
  });

  it('declines when left and right neighbors resolve to different document-flow parents, rather than guessing', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${PLACED_ART}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    writePageContent(doc, 1, content);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const parentA = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef] }));
    const parentB = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [rightRef] }));
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), parentA);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), parentB);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [parentA, parentB] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef]);

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('different document-flow parents');
  });

  it('declines cleanly, with no mutation at all, when the page has no /ParentTree entry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${PLACED_ART}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    writePageContent(doc, 1, content);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    // No /ParentTree set at all.

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No /ParentTree entry found');
    expect(decodePageContent(doc, 1)).toBe(content);
    expect(kidsOf(doc, flowParentRef)).toHaveLength(2);
  });

  it('rolls back every created struct element AND restores the original page bytes when extendParentTree rejects a non-contiguous ParentTree array', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${PLACED_ART}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    writePageContent(doc, 1, content);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef, leftRef, leftRef, leftRef]); // length 5, not 2

    const result = pdfStructureWriterService.retagPlacedPdfAsFigure(doc, issueForPage(1));

    expect(result.success).toBe(false);
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(2);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[1].objectNumber).toBe(rightRef.objectNumber);
    expect(decodePageContent(doc, 1)).toBe(content);
  });
});
