/**
 * Tests for PdfStructureWriterService.fixIndexStructure -- ROLEMAP-INDEX-
 * FLATTENED. Builds a real /Index > /L > /LI > /LBody container around each
 * contiguous run of raw /IDX1(F)?, /IDX2, /IDX3-tagged elements -- see that
 * method's own doc comment (pdf-structure-writer.service.ts) for the full
 * defect and algorithm.
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function indexIssue(): AuditIssue {
  return {
    id: 'rolemap-index-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code: 'ROLEMAP-INDEX-FLATTENED',
    message: 'test',
    element: 'IDX1',
    location: 'Document-wide (style: /IDX1)',
  } as AuditIssue;
}

function tagOf(doc: PDFDocument, ref: PDFRef): string {
  const dict = doc.context.lookup(ref, PDFDict);
  const s = dict.get(PDFName.of('S'));
  return s!.toString().replace(/^\//, '');
}

function parentOf(doc: PDFDocument, ref: PDFRef): PDFRef | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const p = dict.get(PDFName.of('P'));
  return p instanceof PDFRef ? p : undefined;
}

/** Normalizes a struct element's own /K into a flat list of refs, same shape regardless of bare-scalar vs array. */
function kidsOf(doc: PDFDocument, ref: PDFRef): PDFRef[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  if (k instanceof PDFArray) return k.asArray().filter((e): e is PDFRef => e instanceof PDFRef);
  if (k instanceof PDFRef) return [k];
  return [];
}

function mcidOf(doc: PDFDocument, ref: PDFRef): number | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return typeof (k as { asNumber?: () => number })?.asNumber === 'function'
    ? (k as { asNumber: () => number }).asNumber()
    : undefined;
}

/** Leaf struct element: /S = tag, /K = a bare MCID integer (no MCR dict, no children). */
function buildLeaf(doc: PDFDocument, tag: string, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), K: mcid }));
}

/**
 * Document -> Sect (K: kidsK) -- a single intermediate parent holding the
 * flat run (plus any extra siblings `kidsK` already includes), wrapped in a
 * minimal StructTreeRoot with no /RoleMap (fixIndexStructure never reads it
 * -- it classifies purely off each element's own raw /S).
 */
async function buildDocWithParentKids(kidsK: PDFRef[] | PDFRef): Promise<{ doc: PDFDocument; sectRef: PDFRef }> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const sectRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: Array.isArray(kidsK) ? doc.context.obj(kidsK) : kidsK })
  );
  for (const kid of Array.isArray(kidsK) ? kidsK : [kidsK]) {
    doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
  }

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, sectRef };
}

describe('PdfStructureWriterService.fixIndexStructure', () => {
  it('fails cleanly when there is no structure tree root', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(false);
    expect(result.error).toContain('No structure tree root found');
  });

  it('fails cleanly (no run found) when the structure tree has no IDX-tagged elements', async () => {
    const { doc } = await buildDocWithParentKids([]);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(false);
    expect(result.error).toContain('No contiguous run');
  });

  it('wraps a simple flat run of IDX1 entries only -- all become top-level /LI', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const a = buildLeaf(doc, 'IDX1', 0);
    const b = buildLeaf(doc, 'IDX1', 1);
    const c = buildLeaf(doc, 'IDX1', 2);
    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([a, b, c]) })
    );
    for (const kid of [a, b, c]) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(true);
    expect(result.after).toContain('1 new /Index');

    // Sect's own /K now holds exactly ONE child: the new /Index, replacing
    // the entire run (which was its only content).
    const sectKids = kidsOf(doc, sectRef);
    expect(sectKids).toHaveLength(1);
    const indexRef = sectKids[0];
    expect(tagOf(doc, indexRef)).toBe('Index');
    expect(parentOf(doc, indexRef)?.objectNumber).toBe(sectRef.objectNumber);

    const lRefs = kidsOf(doc, indexRef);
    expect(lRefs).toHaveLength(1);
    const topLRef = lRefs[0];
    expect(tagOf(doc, topLRef)).toBe('L');

    const liRefs = kidsOf(doc, topLRef);
    expect(liRefs).toHaveLength(3);
    for (const liRef of liRefs) expect(tagOf(doc, liRef)).toBe('LI');

    // Each LI's sole child is the ORIGINAL element, renamed to /LBody, with
    // its own pre-existing MCID untouched -- no new MCID fabricated.
    const lbodyRefs = liRefs.map((li) => kidsOf(doc, li));
    for (const kids of lbodyRefs) expect(kids).toHaveLength(1);
    const lbodies = lbodyRefs.map((kids) => kids[0]);

    expect(lbodies.map((r) => r.objectNumber)).toEqual([a, b, c].map((r) => r.objectNumber));
    for (const lbody of lbodies) expect(tagOf(doc, lbody)).toBe('LBody');
    expect(mcidOf(doc, a)).toBe(0);
    expect(mcidOf(doc, b)).toBe(1);
    expect(mcidOf(doc, c)).toBe(2);

    // Each LBody's own /P points at its new /LI (not back at Sect).
    for (let i = 0; i < liRefs.length; i++) {
      expect(parentOf(doc, lbodies[i])?.objectNumber).toBe(liRefs[i].objectNumber);
    }
  });

  it('nests correctly through a level sequence IDX1 -> IDX2 -> IDX1 -> IDX2 -> IDX2', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const item1 = buildLeaf(doc, 'IDX1', 0);
    const item2 = buildLeaf(doc, 'IDX2', 1);
    const item3 = buildLeaf(doc, 'IDX1', 2);
    const item4 = buildLeaf(doc, 'IDX2', 3);
    const item5 = buildLeaf(doc, 'IDX2', 4);
    const items = [item1, item2, item3, item4, item5];

    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj(items) })
    );
    for (const kid of items) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());
    expect(result.success).toBe(true);

    const indexRef = kidsOf(doc, sectRef)[0];
    const topLRef = kidsOf(doc, indexRef)[0];
    const topLevelLis = kidsOf(doc, topLRef);
    // Two top-level LIs: one for item1, one for item3.
    expect(topLevelLis).toHaveLength(2);

    const [liA, liC] = topLevelLis;
    // LI A (item1): [LBody(item1), nested L -> LI(item2)]
    const liAKids = kidsOf(doc, liA);
    expect(liAKids).toHaveLength(2);
    expect(tagOf(doc, liAKids[0])).toBe('LBody');
    expect(liAKids[0].objectNumber).toBe(item1.objectNumber);
    const nestedLA = liAKids[1];
    expect(tagOf(doc, nestedLA)).toBe('L');
    const nestedLAKids = kidsOf(doc, nestedLA);
    expect(nestedLAKids).toHaveLength(1);
    expect(tagOf(doc, nestedLAKids[0])).toBe('LI');
    const liBKids = kidsOf(doc, nestedLAKids[0]);
    expect(liBKids).toHaveLength(1);
    expect(liBKids[0].objectNumber).toBe(item2.objectNumber);
    expect(tagOf(doc, liBKids[0])).toBe('LBody');

    // LI C (item3): [LBody(item3), nested L -> [LI(item4), LI(item5)]]
    const liCKids = kidsOf(doc, liC);
    expect(liCKids).toHaveLength(2);
    expect(liCKids[0].objectNumber).toBe(item3.objectNumber);
    expect(tagOf(doc, liCKids[0])).toBe('LBody');
    const nestedLC = liCKids[1];
    expect(tagOf(doc, nestedLC)).toBe('L');
    const nestedLCKids = kidsOf(doc, nestedLC);
    expect(nestedLCKids).toHaveLength(2); // LI(item4), LI(item5) -- siblings reuse the SAME nested L

    const liDKids = kidsOf(doc, nestedLCKids[0]);
    expect(liDKids[0].objectNumber).toBe(item4.objectNumber);
    const liEKids = kidsOf(doc, nestedLCKids[1]);
    expect(liEKids[0].objectNumber).toBe(item5.objectNumber);

    // Every original leaf's own MCID is untouched.
    expect([item1, item2, item3, item4, item5].map((r) => mcidOf(doc, r))).toEqual([0, 1, 2, 3, 4]);
  });

  it('declines a run starting with IDX2 and no preceding IDX1 -- ambiguous, not guessed', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const item = buildLeaf(doc, 'IDX2', 0);
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: item }));
    doc.context.lookup(item, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous nesting');

    // Nothing was mutated -- the lone IDX2 item is exactly where it started.
    expect(tagOf(doc, item)).toBe('IDX2');
    expect(parentOf(doc, item)?.objectNumber).toBe(sectRef.objectNumber);
    expect(kidsOf(doc, sectRef)).toEqual([item]);
  });

  it('declines a run with an IDX3 that has no preceding IDX2 (even with an IDX1 present)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const item1 = buildLeaf(doc, 'IDX1', 0);
    const item3 = buildLeaf(doc, 'IDX3', 1);
    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([item1, item3]) })
    );
    for (const kid of [item1, item3]) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous nesting');
    expect(tagOf(doc, item1)).toBe('IDX1');
    expect(tagOf(doc, item3)).toBe('IDX3');
  });

  it('preserves the sibling immediately after the run, and MCID bindings of surrounding content, splicing /Index in at the run\'s own position', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const before = buildLeaf(doc, 'P', 0);
    const a = buildLeaf(doc, 'IDX1', 1);
    const b = buildLeaf(doc, 'IDX1', 2);
    const after = buildLeaf(doc, 'P', 3);

    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([before, a, b, after]) })
    );
    for (const kid of [before, a, b, after]) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());
    expect(result.success).toBe(true);

    const sectKids = kidsOf(doc, sectRef);
    expect(sectKids).toHaveLength(3); // before, Index, after
    expect(sectKids[0].objectNumber).toBe(before.objectNumber);
    expect(tagOf(doc, sectKids[1])).toBe('Index');
    expect(sectKids[2].objectNumber).toBe(after.objectNumber);

    // The untouched siblings keep their own tags, parent, and MCID.
    expect(tagOf(doc, before)).toBe('P');
    expect(tagOf(doc, after)).toBe('P');
    expect(parentOf(doc, before)?.objectNumber).toBe(sectRef.objectNumber);
    expect(parentOf(doc, after)?.objectNumber).toBe(sectRef.objectNumber);
    expect(mcidOf(doc, before)).toBe(0);
    expect(mcidOf(doc, after)).toBe(3);
  });

  it('handles a parent whose /K is a bare scalar holding the run\'s own sole item (not wrapped in an array)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const item = buildLeaf(doc, 'IDX1', 0);
    // Bare scalar /K -- Sect's ONLY child, not an array.
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: item }));
    doc.context.lookup(item, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    expect(result.success).toBe(true);

    // Sect's own /K must now hold ONLY the new /Index -- no stale duplicate
    // reference to the original item left behind (the real gap this test
    // guards against: removeFromKids only clears an array-shaped /K).
    const sectKids = kidsOf(doc, sectRef);
    expect(sectKids).toHaveLength(1);
    expect(tagOf(doc, sectKids[0])).toBe('Index');

    const topLRef = kidsOf(doc, sectKids[0])[0];
    const liRef = kidsOf(doc, topLRef)[0];
    const lbodyRef = kidsOf(doc, liRef)[0];
    expect(lbodyRef.objectNumber).toBe(item.objectNumber);
    expect(tagOf(doc, lbodyRef)).toBe('LBody');
  });

  it('preserves MCID -> struct-element resolution via /ParentTree after the fix (same object, new ancestor, not lost or duplicated)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const item = doc.context.register(doc.context.obj({ S: PDFName.of('IDX1'), Pg: page.ref, K: 0 }));
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: item }));
    doc.context.lookup(item, PDFDict).set(PDFName.of('P'), sectRef);

    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    const pageArr = doc.context.obj([item]); // /ParentTree's own page-0 array: MCID 0 -> item
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());
    expect(result.success).toBe(true);

    // The /ParentTree's own page array is untouched by this fix (no new
    // MCID, no content-stream edit) -- MCID 0 still resolves to the exact
    // SAME object, which is now the /LBody ancestor of that MCID instead of
    // a flat /IDX1 paragraph.
    const resolvedPageArr = doc.context.lookup((parentTree as PDFDict).get(PDFName.of('Nums')), PDFArray);
    const resolvedPageEntry = doc.context.lookup(resolvedPageArr.get(1), PDFArray);
    expect(resolvedPageEntry.size()).toBe(1); // still exactly one entry -- not duplicated
    const resolvedRef = resolvedPageEntry.get(0) as PDFRef;
    expect(resolvedRef.objectNumber).toBe(item.objectNumber);
    expect(tagOf(doc, resolvedRef)).toBe('LBody');
    expect(mcidOf(doc, resolvedRef)).toBe(0);
  });

  it('rolls back cleanly on an injected failure -- restores the parent /K, every item\'s /S + /P, and deletes every newly created element', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const a = buildLeaf(doc, 'IDX1', 0);
    const b = buildLeaf(doc, 'IDX1', 1);
    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([a, b]) })
    );
    for (const kid of [a, b]) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const originalSectKidsRefs = kidsOf(doc, sectRef).map((r) => r.objectNumber);

    // Force the final post-splice reachability check to fail, simulating a
    // genuinely unexpected failure after the whole subtree has already been
    // built and the parent's /K already rewritten.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reachableSpy = vi.spyOn(pdfStructureWriterService as any, 'isReachableFromRoot').mockReturnValue(false);
    const registerSpy = vi.spyOn(doc.context, 'register');

    const result = pdfStructureWriterService.fixIndexStructure(doc, indexIssue());

    reachableSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.error).toContain('not committing');

    // The parent's own /K is restored to exactly its original members.
    expect(kidsOf(doc, sectRef).map((r) => r.objectNumber)).toEqual(originalSectKidsRefs);

    // Each original item is restored to its own original /S and /P.
    expect(tagOf(doc, a)).toBe('IDX1');
    expect(tagOf(doc, b)).toBe('IDX1');
    expect(parentOf(doc, a)?.objectNumber).toBe(sectRef.objectNumber);
    expect(parentOf(doc, b)?.objectNumber).toBe(sectRef.objectNumber);

    // Every element newly created during this call (the /Index, /L, and
    // both /LI elements) is deleted -- orphaned (no /K, no /P), per
    // deleteElement's own documented semantics.
    const createdRefs = registerSpy.mock.results.map((r) => r.value as PDFRef);
    expect(createdRefs.length).toBeGreaterThan(0);
    for (const ref of createdRefs) {
      const dict = doc.context.lookup(ref, PDFDict);
      expect(dict.get(PDFName.of('K'))).toBeUndefined();
      expect(dict.get(PDFName.of('P'))).toBeUndefined();
    }
  });
});
