/**
 * Regression coverage for fixArtifactSwallowsContent -- the third, distinct
 * Artifact-related defect this session found: a producer-authored top-level
 * /Artifact span whose own boundary is simply wrong, swallowing real
 * content that was never given its own tag at all (confirmed live on
 * Farrar_2E_Comp_188910.pdf page 12: a page-number + running-head Artifact
 * that never closes where it should, continuing through two full real
 * paragraphs). See pdf-artifact-tagger.ts's findOversizedArtifactSpans and
 * ai-analysis.service.ts's analyzeArtifactSwallowsContent for the
 * detection/AI-verification side -- this writer only ever receives an
 * AI-CONFIRMED boundary (the real content's own opening TEXT, one per
 * oversized span on the page, in document order) and re-locates it fresh
 * by an exact text match, never trusting a stored offset or index.
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
    code: 'ARTIFACT-SWALLOWS-CONTENT',
    message: 'Oversized /Artifact span(s) likely swallowing real content',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    suggestion: 'The real content boundary will be determined and given its own structure tag.',
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

/** A flat /Nums-based /ParentTree on `structTreeRootRef`, mapping MCID
 * position to `entries[mcid]` -- same shape the document-flow fallback's
 * own neighbor lookup (and reattachTableRow's) reads from. */
function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a one-page document with a single flow-parent /Document struct
 * element whose /K is [leftRef, rightRef] -- the shared document-flow
 * container the new /Span must be spliced into between its neighbors.
 * `content` is written as the page's own content stream, and the page's
 * /ParentTree maps MCID 0 -> leftRef, MCID 1 -> rightRef (the two REAL
 * tagged neighbors already present before the oversized Artifact is
 * fixed).
 */
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

const REAL_TEXT = 'Real content opens here';
// findOversizedArtifactSpans' default threshold is 15 ops -- pad the
// decorative portion with filler text-show calls so the span is genuinely
// over that threshold, same as the real document's own shape (a page
// number + running head alone would never trip this check).
const FILLER = Array.from({ length: 20 }, (_, i) => `(filler ${i})Tj\n`).join('');
const PAGE_CONTENT =
  `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n` +
  `/Artifact BMC\nBT\n(5)Tj\n(Running Head)Tj\n${FILLER}(${REAL_TEXT})Tj\nET\nEMC\n` +
  `/P <</MCID 1 >>BDC\n(After)Tj\nEMC\n`;

describe('fixArtifactSwallowsContent', () => {
  it('splits the oversized Artifact at the confirmed real-content run and wires a new /Span into the document flow', async () => {
    const { doc, flowParentRef, leftRef, rightRef } = await buildDoc(PAGE_CONTENT);

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(
      doc,
      issueForPage(1),
      JSON.stringify([REAL_TEXT]),
    );

    expect(result.success).toBe(true);
    expect(result.before).toContain('1 oversized /Artifact span');

    // New /Span spliced in BETWEEN the left and right neighbor, since both
    // resolve to the same flow parent and agree.
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(3);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[2].objectNumber).toBe(rightRef.objectNumber);
    const newSpanRef = kids[1];

    const spanDict = doc.context.lookup(newSpanRef, PDFDict);
    expect(spanDict.get(PDFName.of('S'))?.toString()).toBe('/Span');
    expect(spanDict.get(PDFName.of('P'))?.toString()).toBe(flowParentRef.toString());

    const fixedContent = decodePageContent(doc, 1)!;
    // The real content's own bytes are untouched and still present verbatim.
    expect(fixedContent).toContain(`(${REAL_TEXT})Tj`);
    // The decorative filler now sits OUTSIDE any tag at all, immediately
    // followed by the Artifact's close and the new Span's open right
    // before the real content -- the pre-existing closing EMC (never
    // touched) now correctly closes the new Span instead of the Artifact.
    expect(fixedContent).toMatch(/\(filler 19\)Tj\n EMC \/Span <<\/MCID \d+>> BDC \(Real content opens here\)Tj\nET\nEMC\n/);
  });

  it('fails cleanly when no AI-confirmed value is available', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No AI-confirmed boundary data');
  });

  it('fails cleanly when the stored value is not valid JSON', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), 'not json');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a valid JSON string array');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(undefined), JSON.stringify([REAL_TEXT]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no pageNumber');
  });

  it('declines when the oversized-span count on the page no longer matches the analyzed count', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT); // 1 real oversized span on the page
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(
      doc,
      issueForPage(1),
      JSON.stringify([REAL_TEXT, 'a second span that does not exist']),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no longer matches the analyzed count');
  });

  it('declines when the confirmed real-content text can no longer be found on the page, rather than guessing', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(
      doc,
      issueForPage(1),
      JSON.stringify(['This text was never in the document']),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not relocate');
  });

  it('fails cleanly when the page has no oversized Artifact span left (already fixed or moved)', async () => {
    const { doc } = await buildDoc('/P <</MCID 0 >>BDC\n(Just a normal page)Tj\nEMC\n');
    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No oversized Artifact spans found');
  });

  it('declines when neither MCID neighbor resolves to a usable document-flow parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, `/Artifact BMC\nBT\n(5)Tj\n(Running Head)Tj\n${FILLER}(${REAL_TEXT})Tj\nET\nEMC\n`);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, []); // no tagged neighbors exist at all

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no usable tagged neighbor');
  });

  it('declines when left and right neighbors resolve to different document-flow parents, rather than guessing', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, PAGE_CONTENT);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const parentA = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef] }));
    const parentB = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [rightRef] }));
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), parentA);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), parentB);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [parentA, parentB] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, rightRef]);

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));
    expect(result.success).toBe(false);
    expect(result.error).toContain('different document-flow parents');
  });

  it('uses the left neighbor alone when there is no right neighbor (last content on the page)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const content = `/P <</MCID 0 >>BDC\n(Before)Tj\nEMC\n/Artifact BMC\nBT\n(5)Tj\n(Running Head)Tj\n${FILLER}(${REAL_TEXT})Tj\nET\nEMC\n`;
    writePageContent(doc, 1, content);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const flowParentRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef] }));
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef]);

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));
    expect(result.success).toBe(true);
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(2);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
  });

  it('declines cleanly, with no mutation at all, when the page has no /ParentTree entry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, PAGE_CONTENT);

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));
    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    // No /ParentTree set at all -- resolveParentTreePageArray returns null,
    // so this must fail during the planning phase, before any
    // content-stream or struct-tree write happens.

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No /ParentTree entry found');
    expect(decodePageContent(doc, 1)).toBe(PAGE_CONTENT);
    expect(kidsOf(doc, flowParentRef)).toHaveLength(2);
  });

  it('rolls back every created struct element AND restores the original page bytes when extendParentTree rejects a non-contiguous ParentTree array', async () => {
    // The page's own /ParentTree array is 5 entries long (padded beyond
    // what the content stream's own MCIDs 0/1 use), but
    // pageContentMcids-derived allocation (this writer's own MCID source)
    // only sees {0, 1} and allocates MCID 2 next -- extendParentTree's
    // OWN contiguity check is keyed off the ParentTree array's actual
    // length (5), not the content stream, so handing it MCID 2 is
    // rejected. This is the one real way to reach a failure AFTER
    // writePageContent has already run in this writer, confirming the
    // fix for the exact rollback gap CodeRabbit/Codex caught on PR #555's
    // sibling function (buildFigureFromImage): deleteElement alone isn't
    // enough once the page bytes are already mutated.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    writePageContent(doc, 1, PAGE_CONTENT);

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

    const result = pdfStructureWriterService.fixArtifactSwallowsContent(doc, issueForPage(1), JSON.stringify([REAL_TEXT]));

    expect(result.success).toBe(false);
    // The new struct element must not survive -- deleted on rollback.
    const kids = kidsOf(doc, flowParentRef).filter((k): k is PDFRef => k instanceof PDFRef);
    expect(kids).toHaveLength(2);
    expect(kids[0].objectNumber).toBe(leftRef.objectNumber);
    expect(kids[1].objectNumber).toBe(rightRef.objectNumber);
    // The page's own bytes must be restored verbatim -- not left with an
    // orphaned /Span tag and MCID that no struct element owns.
    expect(decodePageContent(doc, 1)).toBe(PAGE_CONTENT);
  });
});
