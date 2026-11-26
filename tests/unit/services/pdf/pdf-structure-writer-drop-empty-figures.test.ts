/**
 * pdf-structure-writer.service.ts — dropEmptyFigures (Rule 3, 2026-11-26)
 *
 * Real bug, confirmed live on a real title (QC regression corpus, T4):
 * dozens of Figure struct elements with no image/vector/text content at
 * all survive a full Auto Mode run, unchanged by two existing related
 * fixes:
 * - #886 only demotes an empty ZONE at struct-tree-builder.ts's INITIAL
 *   per-page auto-tagging pass, before any Figure struct element exists.
 * - #890 fixed mcidHasImageOrVectorContent/extractMcidText to correctly
 *   exclude content nested inside a child struct element or /Artifact,
 *   and gated alt-text dispatch on that corrected check -- but never
 *   acted on the Figure struct element itself.
 *
 * dropEmptyFigures is the FINAL pass that catches this regardless of
 * when or how a given Figure was created -- it retags every one of an
 * empty Figure's own MCIDs to /Artifact and removes the Figure itself
 * from its parent's /K array.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

/**
 * Builds a one-page document with a struct tree of `n` Figure elements
 * (MCID 0..n-1, in order), each with /Pg pointing at the single page, and
 * writes `content` as that page's own content stream. Mirrors the
 * fixture style already established in this file's own
 * buildChain/headingIssue helpers, extended with a real content stream
 * (dropEmptyFigures, unlike fixHeadingHierarchy, reads page content).
 */
async function buildDocWithFigures(content: string, figureCount: number): Promise<{ doc: InstanceType<typeof PDFDocument>; figureRefs: PDFRef[]; pageRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  writePageContent(doc, 1, content);

  const figureRefs: PDFRef[] = [];
  for (let i = 0; i < figureCount; i++) {
    const ref = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), K: i, Pg: page.ref }));
    figureRefs.push(ref);
    const dict = doc.context.lookup(ref) as PDFDict;
    dict.set(PDFName.of('P'), ref); // placeholder, overwritten below once documentRef exists
  }

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj(figureRefs as unknown as PDFRef[]) })
  );
  for (const ref of figureRefs) {
    const dict = doc.context.lookup(ref) as PDFDict;
    dict.set(PDFName.of('P'), documentRef);
  }

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, figureRefs, pageRef: page.ref };
}

function stillInParentK(doc: InstanceType<typeof PDFDocument>, figureRef: PDFRef): boolean {
  const figureDict = doc.context.lookup(figureRef) as PDFDict;
  const parentRaw = figureDict.get(PDFName.of('P'));
  if (!(parentRaw instanceof PDFRef)) return false;
  const parentDict = doc.context.lookup(parentRaw) as PDFDict;
  const k = parentDict.get(PDFName.of('K'));
  if (!(k instanceof PDFArray)) return false;
  return k.asArray().some((item) => item instanceof PDFRef && item.objectNumber === figureRef.objectNumber);
}

describe('pdf-structure-writer.service — dropEmptyFigures', () => {
  it('drops a genuinely empty Figure (no image, no vector, no text) -- retags to /Artifact and removes from the tree', async () => {
    const content = '/Figure <</MCID 0 >>BDC\nq\n0 0 10 10 re\nW n\nQ\nEMC\n';
    const { doc, figureRefs } = await buildDocWithFigures(content, 1);

    const results = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(results).toHaveLength(1);
    expect(results[0].elementId).toBe('figure_p1_mc0');
    expect(results[0].success).toBe(true);
    expect(stillInParentK(doc, figureRefs[0])).toBe(false);

    const finalContent = decodePageContent(doc, 1)!;
    expect(finalContent).toContain('/Artifact BMC');
    expect(finalContent).not.toContain('/Figure');
  });

  it('leaves a Figure with real image content untouched', async () => {
    const content = '/Figure <</MCID 0 >>BDC\n/Im0 Do\nEMC\n';
    const { doc, figureRefs } = await buildDocWithFigures(content, 1);

    const results = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(results).toHaveLength(0);
    expect(stillInParentK(doc, figureRefs[0])).toBe(true);
    expect(decodePageContent(doc, 1)).toContain('/Figure');
  });

  it('leaves a Figure with real text content untouched', async () => {
    const content = '/Figure <</MCID 0 >>BDC\nBT\n(a real caption)Tj\nET\nEMC\n';
    const { doc, figureRefs } = await buildDocWithFigures(content, 1);

    const results = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(results).toHaveLength(0);
    expect(stillInParentK(doc, figureRefs[0])).toBe(true);
  });

  /**
   * The real T4 shape (#890): the Figure's own span opens a nested
   * /Artifact BMC whose matching EMC doesn't appear until AFTER real
   * drawing/text -- none of that content is exposed as the Figure's own,
   * so it must be treated as empty too, not skipped just because SOME
   * drawing operator textually appears somewhere inside its span.
   */
  it('drops a Figure whose only content is nested inside a child /Artifact span (the real T4 shape)', async () => {
    const content = '/Figure <</MCID 0 >>BDC\n/Artifact BMC\n(credit line)Tj\n/Im0 Do\nEMC\nEMC\n';
    const { doc, figureRefs } = await buildDocWithFigures(content, 1);

    const results = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(results).toHaveLength(1);
    expect(stillInParentK(doc, figureRefs[0])).toBe(false);
  });

  it('drops only the empty Figures among several, leaving the real ones alone', async () => {
    const content =
      '/Figure <</MCID 0 >>BDC\nq\n0 0 1 1 re\nW n\nQ\nEMC\n' + // empty
      '/Figure <</MCID 1 >>BDC\n/Im0 Do\nEMC\n' + // real image
      '/Figure <</MCID 2 >>BDC\nEMC\n'; // empty (nothing at all)
    const { doc, figureRefs } = await buildDocWithFigures(content, 3);

    const results = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(results.map((r) => r.elementId).sort()).toEqual(['figure_p1_mc0', 'figure_p1_mc2']);
    expect(stillInParentK(doc, figureRefs[0])).toBe(false);
    expect(stillInParentK(doc, figureRefs[1])).toBe(true);
    expect(stillInParentK(doc, figureRefs[2])).toBe(false);
  });

  it('is idempotent -- a second call on an already-cleaned document finds nothing left', async () => {
    const content = '/Figure <</MCID 0 >>BDC\nEMC\n';
    const { doc } = await buildDocWithFigures(content, 1);

    pdfStructureWriterService.dropEmptyFigures(doc);
    const second = pdfStructureWriterService.dropEmptyFigures(doc);

    expect(second).toHaveLength(0);
  });

  it('returns an empty array when there is no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    expect(pdfStructureWriterService.dropEmptyFigures(doc)).toEqual([]);
  });
});
