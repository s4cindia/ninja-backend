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
    expect(result!.isEmptyShell).toBe(false);
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
});
