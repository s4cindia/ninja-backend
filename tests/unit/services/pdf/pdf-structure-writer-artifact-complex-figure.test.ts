/**
 * Regression coverage for fixComplexArtifactAsFigure -- Tier 2 of
 * ARTIFACT-SWALLOWS-CONTENT-COMPLEX's routing. Retags the complex oversized
 * /Artifact span(s) ai-analysis.service.ts's analyzeComplexArtifactAsFigure
 * confirmed (via one AI vision call per span) to be a meaningful diagram, as
 * a real /Figure struct element -- no /Alt set, same deliberate hand-off to
 * the existing alt-text pipeline's next pass as retagPlacedPdfAsFigure.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { findOversizedArtifactSpans } from '../../../../src/services/pdf/pdf-artifact-tagger';
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

/** Same one-page, two-neighbor document shape as the sibling fixers' own test files. */
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

const GRID_LINE = '0 0 m\n100 0 l\nS\n';
const PATH_FILLER = Array.from({ length: 17 }, () => GRID_LINE).join(''); // 17 path-paint ops, zero text

/** Same normalization analyzeComplexArtifactAsFigure uses to build `value`,
 *  and fixComplexArtifactAsFigure uses to re-match at apply time -- computed
 *  from the real span rather than duplicated by hand, so a test can never
 *  silently drift out of sync with the production normalization. */
function signatureOf(content: string, spanIndex = 0): string {
  const span = findOversizedArtifactSpans(content).filter((s) => s.hasPathOps)[spanIndex];
  return content.slice(span.contentStart, span.closeOpStart).replace(/\s+/g, ' ').trim();
}

describe('fixComplexArtifactAsFigure', () => {
  it('retags the confirmed span as a real /Figure, spliced between its confirmed neighbors, with no /Alt set', async () => {
    const artifactContent = `${PATH_FILLER}`;
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n` +
      `/Artifact BMC\n${artifactContent}EMC\n` +
      `/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
    const { doc, flowParentRef, leftRef, rightRef } = await buildDoc(content);
    const storedValue = JSON.stringify([signatureOf(content)]);

    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), storedValue);

    expect(result.success).toBe(true);
    expect(result.after).toContain('1 real /Figure');

    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(3);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[2].objectNumber).toBe(rightRef.objectNumber);

    const figureRef = kids[1];
    const figureDict = doc.context.lookup(figureRef, PDFDict);
    expect(figureDict.get(PDFName.of('S'))?.toString()).toBe('/Figure');
    expect(figureDict.get(PDFName.of('P'))?.toString()).toBe(flowParentRef.toString());
    expect(figureDict.get(PDFName.of('Alt'))).toBeUndefined();
    const mcid = figureDict.get(PDFName.of('K'));
    expect(mcid).toBeInstanceOf(PDFNumber);

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain(`/Figure <</MCID ${(mcid as PDFNumber).asNumber()}>> BDC`);
    // The pre-existing closing EMC is untouched -- still exactly 3 EMCs
    // total (Before's, the retagged Figure's, After's).
    expect((fixedContent.match(/EMC/g) ?? []).length).toBe(3);
  });

  it('fails cleanly when storedValue is missing or not valid JSON', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}EMC\n`;
    const { doc } = await buildDoc(content);

    const resultNull = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), null);
    expect(resultNull.success).toBe(false);
    expect(resultNull.error).toContain('no valid confirmed-span value');

    const resultGarbage = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), 'not json');
    expect(resultGarbage.success).toBe(false);
    expect(resultGarbage.error).toContain('no valid confirmed-span value');
  });

  it('fails cleanly when storedValue is an empty array', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}EMC\n`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), JSON.stringify([]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty confirmed-span list');
  });

  it('fails cleanly when no complex span on the page still matches the confirmed signature (already fixed or moved)', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}EMC\n`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), JSON.stringify(['a signature that was never really on this page']));
    expect(result.success).toBe(false);
    expect(result.error).toContain('already fixed, or the page changed');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}EMC\n`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(undefined), JSON.stringify([signatureOf(content)]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no pageNumber');
  });

  it('declines when neither MCID neighbor resolves to a usable document-flow parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content = `/Artifact BMC\n${PATH_FILLER}EMC\n`;
    writePageContent(doc, 1, content);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, []);

    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), JSON.stringify([signatureOf(content)]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no usable tagged neighbor');
  });

  it('rolls back every created struct element AND restores the original page bytes when extendParentTree rejects a non-contiguous ParentTree array', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content =
      `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n/Artifact BMC\n${PATH_FILLER}EMC\n/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;
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
    // Length 5, not 2 -- same non-contiguity trap as the sibling fixers' own rollback tests.
    setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef, leftRef, leftRef, leftRef]);

    const result = pdfStructureWriterService.fixComplexArtifactAsFigure(doc, issueForPage(1), JSON.stringify([signatureOf(content)]));

    expect(result.success).toBe(false);
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(2);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[1].objectNumber).toBe(rightRef.objectNumber);
    expect(decodePageContent(doc, 1)).toBe(content);
  });
});
