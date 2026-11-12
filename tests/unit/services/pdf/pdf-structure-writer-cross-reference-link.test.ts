/**
 * Regression coverage for fixCrossReferenceLink/resolveCrossReferenceDestination
 * -- builds a real internal /Link (GoTo action) for a prose cross-reference
 * ("see Chapter 3", "see p. 45") ONLY when the target resolves unambiguously.
 * Reuses buildLinkAnnotationFix (the same splice/ParentTree/rollback core as
 * fixLinkMissingAnnotation) for the actual annotation-writing half; these
 * tests focus on the NEW half -- destination resolution and its "decline
 * rather than guess" gates.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFHexString } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function crossRefIssue(
  pageNumber: number,
  crossReferenceData: NonNullable<AuditIssue['crossReferenceData']>,
): AuditIssue {
  return {
    id: 'cross-ref-1',
    source: 'link-completeness-validator',
    severity: 'moderate',
    code: 'CROSS-REFERENCE-MISSING-LINK',
    message: `Text reads as a cross-reference ("${crossReferenceData.fullText}") but has no underlying Link annotation to its target`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    crossReferenceData,
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a 2-page document: page 1 carries the cross-reference text in one
 * `/P <</MCID 0>>` span (same real shape as the LINK-MISSING-ANNOTATION
 * fixture), page 2 carries a heading struct element with real ActualText --
 * the resolution target. `headingText: null` builds a heading with no real
 * text at all (fallback case); omit `heading` entirely for "no heading on
 * any page."
 */
async function buildDoc(
  crossRefText: string,
  heading?: { text: string | null; level?: number } | { text: string | null; level?: number }[],
): Promise<{ doc: PDFDocument; pRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  page1.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  const page2 = doc.addPage([612, 792]);
  // The cross-reference text is embedded mid-sentence (surrounded by other
  // prose in the SAME text-show operand), so this always needs the same-
  // operand splitter (findUrlSubstringRun), not the "isolated in its own
  // operand" clean path -- that splitter's own font-safety guard requires a
  // resolvable, simple font at the cut point (same real requirement
  // pdf-structure-writer-link-missing-annotation.test.ts's own "falls back
  // to the same-operand splitter" fixture registers).
  writePageContent(doc, 1, `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(For more detail, ${crossRefText} of this document.)Tj\nET EMC`);
  const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
  page1.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page1.ref, K: 0 }));

  const headings = heading ? (Array.isArray(heading) ? heading : [heading]) : [];
  const headingRefs = headings.map(h => {
    const dict: Record<string, unknown> = { S: PDFName.of(`H${h.level ?? 1}`), Pg: page2.ref, K: 0 };
    if (h.text !== null) dict.ActualText = PDFHexString.fromText(h.text);
    return doc.context.register(doc.context.obj(dict));
  });

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef, ...headingRefs] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef };
}

describe('fixCrossReferenceLink', () => {
  it('resolves and links "see Chapter N" to its single matching real-text heading', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(true);
    expect(result.after).toContain('see Chapter 3');
  });

  it('declines when two headings match the same "Chapter N" reference (ambiguous)', async () => {
    const { doc } = await buildDoc('see Chapter 3', [
      { text: 'Chapter 3: Origins' },
      { text: 'Chapter 3: A Different Section' },
    ]);

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unambiguously');
  });

  it('declines when no heading matches the reference at all', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 5: Unrelated Topic' });

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
  });

  it('declines when the matching heading itself has no real (non-fallback) text', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: null });

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' })
    );

    expect(result.success).toBe(false);
  });

  it('resolves "see Section N" the same way as "see Chapter N"', async () => {
    const { doc } = await buildDoc('see Section 2', { text: 'Section 2: Methodology', level: 2 });

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'section', number: '2', fullText: 'see Section 2' })
    );

    expect(result.success).toBe(true);
  });

  it('declines "see Figure N" / "see Table N" -- no resolution path exists for these keywords', async () => {
    const { doc } = await buildDoc('see Figure 2', { text: 'Chapter 3: Financial Risk Assessment' });

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'figure', number: '2', fullText: 'see Figure 2' })
    );

    expect(result.success).toBe(false);
  });

  it('resolves "see page NN" via real /PageLabels when exactly one page matches', async () => {
    const { doc } = await buildDoc('see page 45');
    // Page index 0 (page 1, where the cross-reference text itself lives)
    // prints as "1", page index 1 (page 2) restarts at "45" -- so "45"
    // unambiguously means page index 1.
    const pageLabelsRef = doc.context.register(doc.context.obj({
      Nums: [
        0, doc.context.obj({ S: PDFName.of('D'), St: 1 }),
        1, doc.context.obj({ S: PDFName.of('D'), St: 45 }),
      ],
    }));
    doc.catalog.set(PDFName.of('PageLabels'), pageLabelsRef);

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'page', number: '45', fullText: 'see page 45' })
    );

    expect(result.success).toBe(true);
  });

  it('declines "see page NN" when the document has no /PageLabels at all', async () => {
    const { doc } = await buildDoc('see page 45');

    const result = pdfStructureWriterService.fixCrossReferenceLink(
      doc, crossRefIssue(1, { keyword: 'page', number: '45', fullText: 'see page 45' })
    );

    expect(result.success).toBe(false);
  });

  it('declines cleanly when the issue has no crossReferenceData', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });
    const issue = crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' });
    delete (issue as { crossReferenceData?: unknown }).crossReferenceData;

    const result = pdfStructureWriterService.fixCrossReferenceLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('crossReferenceData');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc('see Chapter 3', { text: 'Chapter 3: Financial Risk Assessment' });
    const issue = crossRefIssue(1, { keyword: 'chapter', number: '3', fullText: 'see Chapter 3' });
    delete (issue as { boundingBox?: unknown }).boundingBox;

    const result = pdfStructureWriterService.fixCrossReferenceLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boundingBox');
  });
});
