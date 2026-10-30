/**
 * Regression coverage for fixArtifactSwallowsContentComplex -- the "has
 * path-paint ops too" sibling of fixArtifactSwallowsContent. Confirmed live
 * on Farrar_2E_Comp_188910.pdf: 9 of 16 remaining "complex" oversized-
 * Artifact pages had real text (two-column glossary tables, running heads,
 * body paragraphs) interleaved with decorative drawing (grid lines, header
 * bars, background shading) inside the SAME top-level Artifact span, which
 * ai-analysis.service.ts's own dispatch previously declined to manual
 * review unconditionally for any span containing a path-paint op. Unlike
 * fixArtifactSwallowsContent, this never needs an AI-confirmed boundary --
 * see findRealTextSegmentsInSpan's own doc comment for why the text/
 * decoration split is a purely structural fact, not a judgment call.
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
    code: 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX',
    message: 'Oversized /Artifact span(s) likely swallowing real content, including vector graphics',
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

/** Same one-page, two-neighbor document shape as the SIMPLE fix's own test
 * file -- a shared /Document flow parent whose /K is [leftRef, rightRef]. */
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

// findOversizedArtifactSpans' default threshold is 15 -- pad with PURELY
// decorative path-paint ops (no text at all) to genuinely trip the
// threshold like the real document's glossary tables do, without the
// filler itself being mistaken for a real text segment.
const GRID_LINE = '0 0 m\n100 0 l\nS\n';
const PATH_FILLER = Array.from({ length: 17 }, () => GRID_LINE).join(''); // 17 path-paint ops, zero text

describe('fixArtifactSwallowsContentComplex', () => {
  it('splits every real-text segment out of a complex span into its own /Span, leaving the decorative drawing Artifact-wrapped', async () => {
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n` +
      `/Artifact BMC\n${PATH_FILLER}(Term A)Tj\n${GRID_LINE}(Term B)Tj\nEMC\n` +
      `/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc, flowParentRef, leftRef, rightRef } = await buildDoc(content);

    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));

    expect(result.success).toBe(true);
    expect(result.after).toContain('2 real text segment(s)');

    // Two new /Span elements spliced in between the left and right neighbor.
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(4);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[3].objectNumber).toBe(rightRef.objectNumber);
    for (const ref of [kids[1], kids[2]]) {
      const dict = doc.context.lookup(ref, PDFDict);
      expect(dict.get(PDFName.of('S'))?.toString()).toBe('/Span');
      expect(dict.get(PDFName.of('P'))?.toString()).toBe(flowParentRef.toString());
    }

    const fixedContent = decodePageContent(doc, 1)!;
    // Both real-text runs are freed into their own Span, and the decorative
    // grid line between them is re-wrapped back into a fresh Artifact.
    expect(fixedContent).toContain('EMC /Span <</MCID 2>> BDC ');
    expect(fixedContent).toMatch(/\(Term A\)Tj EMC \/Artifact BMC \n0 0 m/);
    expect(fixedContent).toContain('(Term B)Tj');
    // Every original byte (grid lines, filler) is still present verbatim.
    expect(fixedContent).toContain(GRID_LINE.trim());
  });

  it('declines cleanly when the complex span is purely decorative (no real text to free)', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}${GRID_LINE}EMC\n`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('purely decorative, nothing to free');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const { doc } = await buildDoc(`/Artifact BMC\n${PATH_FILLER}(Real)Tj\nEMC\n`);
    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(undefined));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no pageNumber');
  });

  it('fails cleanly when the page has no complex (path-containing) oversized span', async () => {
    const { doc } = await buildDoc('/P <</MCID 0 >>BDC\n(Just a normal page)Tj\nEMC\n');
    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No complex oversized Artifact spans found');
  });

  it('declines when neither MCID neighbor resolves to a usable document-flow parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, `/Artifact BMC\n${PATH_FILLER}(Real)Tj\nEMC\n`);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, []); // no tagged neighbors exist at all -- matches the live
    // Farrar whole-page-is-one-Artifact cases (pages 12/46/123), where this
    // method must decline rather than guess at a document-flow anchor.

    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no usable tagged neighbor');
  });

  it('declines when left and right neighbors resolve to different document-flow parents, rather than guessing', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n/Artifact BMC\n${PATH_FILLER}(Real)Tj\nEMC\n/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
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

    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('different document-flow parents');
  });

  it('declines cleanly, with no mutation at all, when the page has no /ParentTree entry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n/Artifact BMC\n${PATH_FILLER}(Real)Tj\nEMC\n/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
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

    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No /ParentTree entry found');
    expect(decodePageContent(doc, 1)).toBe(content);
    expect(kidsOf(doc, flowParentRef)).toHaveLength(2);
  });

  it('rolls back every created struct element AND restores the original page bytes when extendParentTree rejects a non-contiguous ParentTree array', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n/Artifact BMC\n${PATH_FILLER}(Real)Tj\nEMC\n/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
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
    // Length 5, not 2 -- same non-contiguity trap as the SIMPLE fix's own
    // equivalent rollback test.
    setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef, leftRef, leftRef, leftRef]);

    const result = pdfStructureWriterService.fixArtifactSwallowsContentComplex(doc, issueForPage(1));

    expect(result.success).toBe(false);
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(2);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[1].objectNumber).toBe(rightRef.objectNumber);
    expect(decodePageContent(doc, 1)).toBe(content);
  });
});
