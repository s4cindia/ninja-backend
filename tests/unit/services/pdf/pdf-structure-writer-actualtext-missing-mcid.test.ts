/**
 * Regression coverage for fixActualTextMissingMcid -- the ACTUAL fix for
 * the defect fixArtifactActualTextSibling (PR #780) turned out not to be.
 * Confirmed live on Karsaklian_189165_9781606497623 AFTER that earlier fix
 * shipped and deployed: a fresh PAC run on the remediated output still
 * reported "Text object not tagged" on the exact same running-header text,
 * because /Span <</ActualText>> with no real /MCID is just as invisible to
 * PDF/UA conformance checking as /Artifact is. See
 * pdf-artifact-tagger.ts's own findActualTextRunsMissingMcid doc comment
 * for the full story. This gives genuine struct-tree reachability: one new
 * /Span struct element per run, its own /K an array of fresh MCIDs (one
 * per fragment), anchored into the tree via the same document-flow
 * neighbor resolution fixArtifactSwallowsContentComplex already uses.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: `issue-page-${pageNumber ?? 'none'}`,
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ACTUALTEXT-MISSING-MCID',
    message: '/Span <</ActualText>> content with no real /MCID',
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

/** Same one-page, two-neighbor document shape as fixArtifactSwallowsContentComplex's own test file -- a shared /Document flow parent whose /K is [leftRef, rightRef]. */
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

// Real shape confirmed live on page 12: "Description" split into 4
// ActualText-no-MCID fragments (D, ESCRIPTI, O, N), no /Artifact left at
// all (after findArtifactWrappedActualTextSiblings's own fix already ran).
const DESCRIPTION_RUN =
  '/Span <</ActualText (D)>> BDC \n(D)Tj\n EMC ' +
  '/Span<</ActualText<FEFF00650073006300720069007000740069>>> BDC \n(ESCRIPTI)Tj\n' +
  'EMC /Span <</ActualText (o)>> BDC   \n(O)Tj\n EMC ' +
  '/Span<</ActualText<FEFF006E>>> BDC \n(N)Tj\nEMC\n';

describe('PdfStructureWriterService.fixActualTextMissingMcid', () => {
  it('gives the real Karsaklian_189165 "Description" run a genuine struct element with 4 real MCIDs, anchored between its tagged neighbors', async () => {
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${DESCRIPTION_RUN}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc, flowParentRef, leftRef, rightRef } = await buildDoc(content);

    const result = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));
    expect(result.success).toBe(true);
    expect(result.after).toContain('4 fragment(s)');

    // One new /Span struct element spliced in between the left and right neighbor.
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(3);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[2].objectNumber).toBe(rightRef.objectNumber);

    const newSpanRef = kids[1];
    const newSpanDict = doc.context.lookup(newSpanRef, PDFDict);
    expect(newSpanDict.get(PDFName.of('S'))?.toString()).toBe('/Span');
    expect(newSpanDict.get(PDFName.of('P'))?.toString()).toBe(flowParentRef.toString());

    // Its own /K is an array of 4 fresh MCIDs (starting at 2, since 0/1 are taken).
    const kArr = newSpanDict.get(PDFName.of('K'));
    expect(kArr).toBeInstanceOf(PDFArray);
    const mcids = (kArr as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect(mcids).toEqual([2, 3, 4, 5]);

    // The content stream itself now carries a real /MCID per fragment,
    // and every original byte (the ActualText values, the Tj text) is untouched.
    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('/Span <</MCID 2 /ActualText (D)>> BDC');
    expect(fixedContent).toContain('/Span<</MCID 3 /ActualText<FEFF00650073006300720069007000740069>>> BDC');
    expect(fixedContent).toContain('/Span <</MCID 4 /ActualText (o)>> BDC');
    expect(fixedContent).toContain('/Span<</MCID 5 /ActualText<FEFF006E>>> BDC');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${DESCRIPTION_RUN}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(undefined));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no pageNumber');
  });

  it('fails cleanly when the page has no ActualText-missing-MCID run at all', async () => {
    const { doc } = await buildDoc('/P <</MCID 0 >>BDC\n(Just a normal page)Tj\nEMC\n');
    const result = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No ActualText-tagged content missing a real /MCID found');
  });

  it('is idempotent -- running it again on the already-fixed page finds nothing left to do', async () => {
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${DESCRIPTION_RUN}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc } = await buildDoc(content);
    pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));

    const second = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));
    expect(second.success).toBe(false);
  });

  it('rolls back the content stream entirely when the later /ParentTree commit fails, leaving no partial /MCID insertion behind', async () => {
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n${DESCRIPTION_RUN}/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc, flowParentRef } = await buildDoc(content);

    // A stale /ParentTree page array (3 entries) that doesn't match the
    // real content's own next-available MCID (2) -- forces extendParentTree's
    // own contiguity check to reject the commit, same construction as
    // fixArtifactSwallowsContentComplex's own analogous rollback test.
    const structRootRef = doc.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef;
    const structRoot = doc.context.lookup(structRootRef, PDFDict);
    const staleArr = doc.context.obj([
      doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
      doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
      doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
    ]);
    structRoot.set(PDFName.of('ParentTree'), doc.context.obj({ Nums: [0, staleArr] }));

    const before = decodePageContent(doc, 1)!;
    const result = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));
    expect(result.success).toBe(false);

    // Content stream byte-for-byte unchanged, and no orphaned new /Span
    // struct element left dangling in the flow parent's /K.
    expect(decodePageContent(doc, 1)).toBe(before);
    expect(kidsOf(doc, flowParentRef)).toHaveLength(2);
  });

  it('declines (does not guess) when the run has no usable tagged neighbor on the page to anchor to', async () => {
    const { doc } = await buildDoc(DESCRIPTION_RUN); // no left/right tagged neighbor at all
    const result = pdfStructureWriterService.fixActualTextMissingMcid(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no usable tagged neighbor');
  });
});
