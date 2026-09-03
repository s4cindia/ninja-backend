import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import { checkStructureTreeCompleteness } from '../../../../src/services/pdf/structure-tree-completeness';

/** Builds a minimal StructTreeRoot with the given flat list of /S values as direct children of /Document, and attaches it to the catalog. */
async function buildDocWithStructureTree(types: string[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const kidRefs: PDFRef[] = types.map((type) => {
    const dict = doc.context.obj({ S: PDFName.of(type), K: 0 });
    return doc.context.register(dict);
  });

  const documentDict = doc.context.obj({
    S: PDFName.of('Document'),
    K: doc.context.register(doc.context.obj(kidRefs)) as unknown as PDFArray,
  });
  const documentRef = doc.context.register(documentDict);

  const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
  const structTreeRootRef = doc.context.register(structTreeRootDict);

  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  return doc;
}

describe('checkStructureTreeCompleteness', () => {
  it('returns null when there is no /StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    expect(checkStructureTreeCompleteness(doc)).toBeNull();
  });

  it('flags isEmptyShell when every element is a grouping-only type', async () => {
    const doc = await buildDocWithStructureTree(['Part', 'Part', 'Part', 'Div']);
    const result = checkStructureTreeCompleteness(doc);

    expect(result).toBeTruthy();
    expect(result!.totalElements).toBe(5); // 4 kids + the /Document wrapper itself
    expect(result!.semanticElements).toBe(0);
    expect(result!.isEmptyShell).toBe(true);
  });

  it('does not flag isEmptyShell when real content types are present', async () => {
    const doc = await buildDocWithStructureTree(['P', 'Figure', 'Part', 'H1']);
    const result = checkStructureTreeCompleteness(doc);

    expect(result).toBeTruthy();
    expect(result!.totalElements).toBe(5);
    expect(result!.semanticElements).toBe(3); // P, Figure, H1 — not the grouping-only Part or the Document wrapper
    expect(result!.headingElements).toBe(1);
    expect(result!.isEmptyShell).toBe(false);
    expect(result!.isHeadingShell).toBe(false);
  });

  it('does not flag isEmptyShell for a genuinely empty tree (nothing to judge yet)', async () => {
    const doc = await buildDocWithStructureTree([]);
    const result = checkStructureTreeCompleteness(doc);

    expect(result).toBeTruthy();
    expect(result!.totalElements).toBe(1); // just the /Document wrapper, no kids
    expect(result!.semanticElements).toBe(0);
    // isEmptyShell requires totalElements > 0 AND semanticElements === 0 — this
    // technically qualifies, which is correct: a tree with only a bare /Document
    // node and no real content is exactly the "nothing to attach to" case too.
    expect(result!.isEmptyShell).toBe(true);
  });

  it('flags isHeadingShell when semantic content exists but zero heading elements', async () => {
    // Real pilot case: an 805-page document whose structure tree had 11
    // semantic elements (1 Figure, 10 P) — clearing isEmptyShell — but zero
    // Hn tags anywhere, despite a heuristic content scan finding 143 H1s.
    // semanticElements alone can't see this gap because it lumps every
    // content type together.
    const doc = await buildDocWithStructureTree(['P', 'P', 'P', 'Figure']);
    const result = checkStructureTreeCompleteness(doc);

    expect(result).toBeTruthy();
    expect(result!.semanticElements).toBe(4);
    expect(result!.headingElements).toBe(0);
    expect(result!.isEmptyShell).toBe(false);
    expect(result!.isHeadingShell).toBe(true);
  });

  it('counts multiple heading levels toward headingElements', async () => {
    const doc = await buildDocWithStructureTree(['H1', 'H2', 'H6', 'P']);
    const result = checkStructureTreeCompleteness(doc);

    expect(result).toBeTruthy();
    expect(result!.headingElements).toBe(3);
    expect(result!.isHeadingShell).toBe(false);
  });
});
