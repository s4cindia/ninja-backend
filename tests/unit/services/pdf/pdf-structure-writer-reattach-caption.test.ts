/**
 * Regression coverage for reattachFigureCaption: reconnects a figure
 * caption's /Story wrapper into the structure tree as a sibling immediately
 * after its figure's own single-child /Sect wrapper -- see
 * pdf-figure-caption-tree.validator.ts's own header comment for the real
 * defect this fixes (confirmed on Math_Weir_PDF.pdf: 66/66 real
 * disconnected captions fixed and re-audit-confirmed).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueFor(elementId: string, pageNumber = 1): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-figure-caption-tree',
    severity: 'serious',
    code: 'FIGURE-CAPTION-DISCONNECTED',
    message: `Figure caption "${elementId}" on page ${pageNumber} is disconnected`,
    wcagCriteria: ['1.3.1'],
    location: `Page ${pageNumber}`,
    suggestion: 'Reattach the caption',
    category: 'structure',
    element: elementId,
    pageNumber,
  } as AuditIssue;
}

/**
 * Builds the confirmed-real shape:
 *   Grandparent (K: array, [otherSibling?, Sect])
 *     -> Sect (K: bare, single child, P: Grandparent) -> Figure (mcid 0)
 *   Story (K: bare) -> fc (mcid 1) -- registered but with NO /P at all and
 *   not referenced by anything, matching every one of the 66 real cases.
 * ParentTree cross-references both mcid 0 and mcid 1 regardless.
 */
async function buildDisconnectedCaptionDoc(opts: { withLeadingSibling?: boolean } = {}): Promise<{ doc: PDFDocument; grandparentRef: PDFRef; sectRef: PDFRef; storyRef: PDFRef; fcRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 0 }));
  const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: figureRef }));
  doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), sectRef);

  const fcRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: 1 }));
  const storyRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: fcRef }));
  doc.context.lookup(fcRef, PDFDict).set(PDFName.of('P'), storyRef);
  // Deliberately NO /P on storyRef, and NOT referenced by any /K -- the
  // exact disconnected shape confirmed real.

  const leadingSibling = opts.withLeadingSibling
    ? doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: page.ref, K: 99 }))
    : null;
  const grandparentKids = leadingSibling ? [leadingSibling, sectRef] : [sectRef];
  const grandparentRef = doc.context.register(doc.context.obj({ S: PDFName.of('tx'), K: grandparentKids }));
  doc.context.lookup(sectRef, PDFDict).set(PDFName.of('P'), grandparentRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [grandparentRef] }));
  const pageArr = doc.context.obj([figureRef, fcRef]);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, grandparentRef, sectRef, storyRef, fcRef };
}

describe('PdfStructureWriterService.reattachFigureCaption', () => {
  it('reattaches the /Story as the sibling immediately after its figure\'s /Sect, and sets the /Story\'s own /P', async () => {
    const { doc, grandparentRef, sectRef, storyRef } = await buildDisconnectedCaptionDoc();

    const results = pdfStructureWriterService.reattachFigureCaption(doc, [issueFor('caption_p1_mc1')]);

    expect(results[0].success).toBe(true);

    const gpDict = doc.context.lookup(grandparentRef, PDFDict);
    const kArr = doc.context.lookup(gpDict.get(PDFName.of('K')) as PDFRef, PDFArray) ?? gpDict.get(PDFName.of('K'));
    const entries = (kArr as PDFArray).asArray();
    const sectIdx = entries.findIndex(e => e instanceof PDFRef && e.objectNumber === sectRef.objectNumber);
    expect(entries[sectIdx + 1]).toBeInstanceOf(PDFRef);
    expect((entries[sectIdx + 1] as PDFRef).objectNumber).toBe(storyRef.objectNumber);

    const storyDict = doc.context.lookup(storyRef, PDFDict);
    expect(storyDict.get(PDFName.of('P'))).toBeInstanceOf(PDFRef);
    expect((storyDict.get(PDFName.of('P')) as PDFRef).objectNumber).toBe(grandparentRef.objectNumber);
  });

  it('inserts after the Sect even when the grandparent already has other children before it', async () => {
    const { doc, grandparentRef, sectRef, storyRef } = await buildDisconnectedCaptionDoc({ withLeadingSibling: true });

    const results = pdfStructureWriterService.reattachFigureCaption(doc, [issueFor('caption_p1_mc1')]);

    expect(results[0].success).toBe(true);
    const gpDict = doc.context.lookup(grandparentRef, PDFDict);
    const entries = (gpDict.get(PDFName.of('K')) as PDFArray).asArray();
    expect(entries).toHaveLength(3); // leadingSibling, Sect, Story
    const sectIdx = entries.findIndex(e => e instanceof PDFRef && e.objectNumber === sectRef.objectNumber);
    expect((entries[sectIdx + 1] as PDFRef).objectNumber).toBe(storyRef.objectNumber);
  });

  it('fails cleanly with an unrecognized element id', async () => {
    const doc = await PDFDocument.create();
    const results = pdfStructureWriterService.reattachFigureCaption(doc, [issueFor('not-a-caption-id')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Unrecognized element id');
  });

  it('fails cleanly when no /Figure precedes the caption on the same page', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const fcRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: 0 }));
    const storyRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: fcRef }));
    doc.context.lookup(fcRef, PDFDict).set(PDFName.of('P'), storyRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    const pageArr = doc.context.obj([fcRef]); // mcid 0 = fc, no Figure anywhere before it
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachFigureCaption(doc, [issueFor('caption_p1_mc0')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No preceding /Figure');
  });

  it('fails cleanly (declines rather than guesses) when the figure\'s own parent already has multiple children', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 0 }));
    const otherChildRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: page.ref, K: 5 }));
    // Sect already has TWO children -- an unverified shape this fix should decline.
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: [figureRef, otherChildRef] }));
    doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), sectRef);

    const fcRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: 1 }));
    const storyRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: fcRef }));
    doc.context.lookup(fcRef, PDFDict).set(PDFName.of('P'), storyRef);

    const grandparentRef = doc.context.register(doc.context.obj({ S: PDFName.of('tx'), K: [sectRef] }));
    doc.context.lookup(sectRef, PDFDict).set(PDFName.of('P'), grandparentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [grandparentRef] }));
    const pageArr = doc.context.obj([figureRef, fcRef]);
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachFigureCaption(doc, [issueFor('caption_p1_mc1')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('multiple children');
  });
});
