/**
 * Regression coverage for extendParentTree (Slice 2c of the
 * MATTERHORN-15-001 from-scratch retagger, see the plan at
 * delegated-prancing-candy.md): extends a page's /ParentTree entry with new
 * MCID -> owning-struct-element mappings, matching the real number-tree
 * shape confirmed live against Math_Kim (flat [key, value, key, value, ...]
 * /Nums array, page /StructParents as key, an inline array of refs
 * positionally indexed by MCID as value).
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

/** A trivial struct element, standing in for whatever Slice 2d's skeleton assembly would create. */
function buildStructElem(doc: PDFDocument): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of('Span') }));
}

async function setup(): Promise<{ doc: PDFDocument; page: ReturnType<PDFDocument['addPage']> }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  return { doc, page };
}

function setStructParents(page: ReturnType<PDFDocument['addPage']>, value: number): void {
  page.node.set(PDFName.of('StructParents'), PDFNumber.of(value));
}

function attachStructTreeRoot(doc: PDFDocument, fields: Record<string, unknown> = {}): PDFDict {
  const structRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), ...fields }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRootRef);
  return doc.context.lookup(structRootRef) as PDFDict;
}

function getParentTreeDict(doc: PDFDocument, structRoot: PDFDict): PDFDict {
  const ref = structRoot.get(PDFName.of('ParentTree'));
  const dict = doc.context.lookup(ref as PDFRef);
  expect(dict).toBeInstanceOf(PDFDict);
  return dict as PDFDict;
}

function numsFlat(doc: PDFDocument, parentTreeDict: PDFDict): unknown[] {
  const nums = parentTreeDict.get(PDFName.of('Nums'));
  expect(nums).toBeInstanceOf(PDFArray);
  return (nums as PDFArray).asArray();
}

describe('PdfStructureWriterService.extendParentTree', () => {
  it('creates /ParentTree from scratch when the document has none at all', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const structRoot = attachStructTreeRoot(doc);
    const elemRef = buildStructElem(doc);

    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }]);

    const parentTreeDict = getParentTreeDict(doc, structRoot);
    const flat = numsFlat(doc, parentTreeDict);
    expect(flat).toHaveLength(2);
    expect((flat[0] as PDFNumber).asNumber()).toBe(0);
    expect(flat[1]).toBeInstanceOf(PDFArray);
    expect((flat[1] as PDFArray).asArray()).toEqual([elemRef]);
  });

  it('extends an existing page array entry by appending, preserving array-index-equals-MCID', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const elem0 = buildStructElem(doc);
    const elem1 = buildStructElem(doc);
    const existingArr = doc.context.obj([elem0, elem1]);
    const structRoot = attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Nums: doc.context.obj([PDFNumber.of(0), existingArr]) })),
    });

    const elem2 = buildStructElem(doc);
    const elem3 = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [
      { mcid: 2, structElementRef: elem2 },
      { mcid: 3, structElementRef: elem3 },
    ]);

    const parentTreeDict = getParentTreeDict(doc, structRoot);
    const flat = numsFlat(doc, parentTreeDict);
    expect(flat).toHaveLength(2); // still one page entry
    const valueArr = flat[1] as PDFArray;
    expect(valueArr.asArray()).toEqual([elem0, elem1, elem2, elem3]);
  });

  it('inserts a new page entry in sorted key order among existing entries for OTHER pages, when the new key belongs in the middle', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 5); // this page's key sits between the two pre-existing ones
    const otherElemA = buildStructElem(doc);
    const otherElemB = buildStructElem(doc);
    const structRoot = attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({
        Nums: doc.context.obj([
          PDFNumber.of(1), doc.context.obj([otherElemA]),
          PDFNumber.of(9), doc.context.obj([otherElemB]),
        ]),
      })),
    });

    const newElem = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: newElem }]);

    const parentTreeDict = getParentTreeDict(doc, structRoot);
    const flat = numsFlat(doc, parentTreeDict);
    expect(flat).toHaveLength(6); // 3 page entries * 2
    expect((flat[0] as PDFNumber).asNumber()).toBe(1);
    expect((flat[2] as PDFNumber).asNumber()).toBe(5); // inserted in the middle
    expect(((flat[3]) as PDFArray).asArray()).toEqual([newElem]);
    expect((flat[4] as PDFNumber).asNumber()).toBe(9);
  });

  it('reads /StructParents from the page rather than assuming it equals pageNumber - 1', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 7); // deliberately NOT 0, even though this is page 1 (pageNumber - 1 === 0)
    const structRoot = attachStructTreeRoot(doc);
    const elemRef = buildStructElem(doc);

    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }]);

    const parentTreeDict = getParentTreeDict(doc, structRoot);
    const flat = numsFlat(doc, parentTreeDict);
    expect((flat[0] as PDFNumber).asNumber()).toBe(7); // keyed by /StructParents, not pageNumber - 1
  });

  it('throws rather than promoting a non-array existing entry to array form', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const lonelyRef = buildStructElem(doc); // a bare ref, not wrapped in an array -- the out-of-scope shape
    const structRoot = attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Nums: doc.context.obj([PDFNumber.of(0), lonelyRef]) })),
    });
    void structRoot;

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }])).toThrow(/not an array/);
  });

  it('throws when a requested MCID does not append contiguously onto an existing array', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const elem0 = buildStructElem(doc);
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Nums: doc.context.obj([PDFNumber.of(0), doc.context.obj([elem0])]) })),
    });

    const elemRef = buildStructElem(doc);
    // Array already has 1 entry (MCID 0) -- next must be MCID 1, not 2 (a gap) or 0 (a collision).
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 2, structElementRef: elemRef }])).toThrow(/contiguously/);
  });

  it('throws when a new page entry does not start at MCID 0', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    attachStructTreeRoot(doc);

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 1, structElementRef: elemRef }])).toThrow(/start at MCID 0/);
  });

  it('throws when the page has no /StructParents entry at all', async () => {
    const { doc } = await setup(); // no setStructParents call
    attachStructTreeRoot(doc);

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }])).toThrow(/no \/StructParents/);
  });

  it('throws when there is no structure tree root at all', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    // no attachStructTreeRoot call

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }])).toThrow(/structure tree/i);
  });

  it('is a no-op for an empty entries list', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const structRoot = attachStructTreeRoot(doc);

    pdfStructureWriterService.extendParentTree(doc, 1, []);

    expect(structRoot.get(PDFName.of('ParentTree'))).toBeUndefined();
  });

  /**
   * A number-tree node has EITHER /Kids (a hierarchical intermediate/root
   * node) OR /Nums (a leaf with real key-value pairs), never both -- when
   * /Kids is present, the real page mapping lives under whichever leaf's
   * /Limits covers the page's key, not at the root. Originally a hard
   * decline (PR #551, "real, separate work"); extended to walk /Kids once
   * this hit 11 real permanently-failed link-missing-annotation-fix
   * suggestions on a real document (Karsaklian_189165).
   */
  it('walks a single-level /Kids tree to the one leaf whose /Limits covers the page key, and appends into its /Nums', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 5);
    const elem0 = buildStructElem(doc);
    const leafNums = doc.context.obj([PDFNumber.of(5), doc.context.obj([elem0])]);
    const leafRef = doc.context.register(doc.context.obj({ Nums: leafNums, Limits: doc.context.obj([PDFNumber.of(0), PDFNumber.of(9)]) }));
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Kids: doc.context.obj([leafRef]) })),
    });

    const elem1 = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 1, structElementRef: elem1 }]);

    const leafDict = doc.context.lookup(leafRef) as PDFDict;
    const flat = numsFlat(doc, leafDict);
    expect(flat).toHaveLength(2); // still one page entry, inside the leaf
    const valueArr = flat[1] as PDFArray;
    expect(valueArr.asArray()).toEqual([elem0, elem1]);
  });

  it('picks the correct leaf out of several siblings by /Limits, matching the real multi-leaf shape confirmed on Karsaklian_189165 (5 leaves, 178 entries)', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 40); // falls in leaf B's [32,63] range, not leaf A's [0,31]
    const leafAElem = buildStructElem(doc);
    const leafARef = doc.context.register(doc.context.obj({
      Nums: doc.context.obj([PDFNumber.of(0), doc.context.obj([leafAElem])]),
      Limits: doc.context.obj([PDFNumber.of(0), PDFNumber.of(31)]),
    }));
    const leafBElem = buildStructElem(doc);
    const leafBNums = doc.context.obj([PDFNumber.of(40), doc.context.obj([leafBElem])]);
    const leafBRef = doc.context.register(doc.context.obj({
      Nums: leafBNums,
      Limits: doc.context.obj([PDFNumber.of(32), PDFNumber.of(63)]),
    }));
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Kids: doc.context.obj([leafARef, leafBRef]) })),
    });

    const newElem = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 1, structElementRef: newElem }]);

    // Leaf A (the wrong leaf) must be untouched.
    const leafADict = doc.context.lookup(leafARef) as PDFDict;
    expect(numsFlat(doc, leafADict)).toHaveLength(2);

    const leafBDict = doc.context.lookup(leafBRef) as PDFDict;
    const flatB = numsFlat(doc, leafBDict);
    const valueArr = flatB[1] as PDFArray;
    expect(valueArr.asArray()).toEqual([leafBElem, newElem]);
  });

  it('walks a 2-level-deep /Kids chain (an intermediate node whose own children are the real leaves), confirming the walk is genuinely recursive, not a single-level special case', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 10);
    const leafElem = buildStructElem(doc);
    const leafNums = doc.context.obj([PDFNumber.of(10), doc.context.obj([leafElem])]);
    const leafRef = doc.context.register(doc.context.obj({ Nums: leafNums, Limits: doc.context.obj([PDFNumber.of(10), PDFNumber.of(19)]) }));
    const intermediateRef = doc.context.register(doc.context.obj({
      Kids: doc.context.obj([leafRef]),
      Limits: doc.context.obj([PDFNumber.of(0), PDFNumber.of(19)]),
    }));
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Kids: doc.context.obj([intermediateRef]) })),
    });

    const newElem = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 1, structElementRef: newElem }]);

    const leafDict = doc.context.lookup(leafRef) as PDFDict;
    const valueArr = numsFlat(doc, leafDict)[1] as PDFArray;
    expect(valueArr.asArray()).toEqual([leafElem, newElem]);
  });

  it('throws rather than guessing when no /Kids leaf\'s /Limits covers the page key -- no slot exists anywhere in the tree for it yet', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 999); // outside every leaf's range below
    const leafRef = doc.context.register(doc.context.obj({
      Nums: doc.context.obj([]),
      Limits: doc.context.obj([PDFNumber.of(0), PDFNumber.of(31)]),
    }));
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Kids: doc.context.obj([leafRef]) })),
    });

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }])).toThrow(/no .* leaf node's \/Limits covers page key 999/);
  });

  it('throws when a /Kids child node has neither /Nums nor /Kids of its own (malformed tree)', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 5);
    const malformedKidRef = doc.context.register(doc.context.obj({ Limits: doc.context.obj([PDFNumber.of(0), PDFNumber.of(31)]) }));
    attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Kids: doc.context.obj([malformedKidRef]) })),
    });

    const elemRef = buildStructElem(doc);
    expect(() => pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }])).toThrow(/neither \/Nums nor \/Kids/);
  });

  /**
   * Regression for a real Codex finding on PR #551: /ParentTreeNextKey must
   * stay greater than every key in the parent tree (a separate mechanism --
   * assigning /StructParent keys to annotations -- relies on that
   * invariant). Introducing a brand-new page key >= the current counter
   * must raise it, or a later annotation-tagging operation could reuse the
   * same key.
   */
  it('raises /ParentTreeNextKey when a newly-inserted page key would violate its invariant', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 5);
    const structRoot = attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Nums: doc.context.obj([]) })),
      ParentTreeNextKey: PDFNumber.of(3), // already <= the new key (5) -- must be raised
    });

    const elemRef = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }]);

    expect((structRoot.get(PDFName.of('ParentTreeNextKey')) as PDFNumber).asNumber()).toBe(6);
  });

  it('does not touch /ParentTreeNextKey when extending an EXISTING page entry (no new top-level key introduced)', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const elem0 = buildStructElem(doc);
    const structRoot = attachStructTreeRoot(doc, {
      ParentTree: doc.context.register(doc.context.obj({ Nums: doc.context.obj([PDFNumber.of(0), doc.context.obj([elem0])]) })),
      ParentTreeNextKey: PDFNumber.of(1),
    });

    const elem1 = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 1, structElementRef: elem1 }]);

    expect((structRoot.get(PDFName.of('ParentTreeNextKey')) as PDFNumber).asNumber()).toBe(1);
  });

  it('does not invent /ParentTreeNextKey on a document that never had one', async () => {
    const { doc, page } = await setup();
    setStructParents(page, 0);
    const structRoot = attachStructTreeRoot(doc); // no ParentTreeNextKey field at all

    const elemRef = buildStructElem(doc);
    pdfStructureWriterService.extendParentTree(doc, 1, [{ mcid: 0, structElementRef: elemRef }]);

    expect(structRoot.get(PDFName.of('ParentTreeNextKey'))).toBeUndefined();
  });
});
