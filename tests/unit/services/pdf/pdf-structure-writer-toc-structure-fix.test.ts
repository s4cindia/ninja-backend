/**
 * Tests for PdfStructureWriterService.fixTocStructure -- TOC-STRUCTURE-
 * MISSING. Retags a TOC page's rows (confirmed real on
 * Karsaklian_189165_9781606497623.pdf: each row is already exactly ONE
 * existing struct element whose own /K bundles title + dot-leader + label
 * MCIDs together) into real /TOC > /TOCI structure (ISO 32000-1 Table 333),
 * one /TOC per maximal contiguous run of rows -- see that method's own doc
 * comment (pdf-structure-writer.service.ts) for the full defect and
 * algorithm.
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function tocStructureIssue(pageNumber: number): AuditIssue {
  return {
    id: 'toc-structure-1',
    source: 'pdf-toc-validator',
    severity: 'moderate',
    code: 'TOC-STRUCTURE-MISSING',
    message: 'test',
    category: 'structure',
    pageNumber,
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

function kidsOf(doc: PDFDocument, ref: PDFRef): PDFRef[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  if (k instanceof PDFArray) return k.asArray().filter((e): e is PDFRef => e instanceof PDFRef);
  if (k instanceof PDFRef) return [k];
  return [];
}

function mcidsOf(doc: PDFDocument, ref: PDFRef): number[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  const asNumber = (v: unknown): number | undefined =>
    typeof (v as { asNumber?: () => number })?.asNumber === 'function' ? (v as { asNumber: () => number }).asNumber() : undefined;
  const direct = asNumber(k);
  if (direct !== undefined) return [direct];
  if (k instanceof PDFArray) {
    return k.asArray().map(asNumber).filter((n): n is number => n !== undefined);
  }
  return [];
}

/** Leaf struct element whose /K is an array of bare MCID integers -- the
 *  real shape a TOC row's own existing element already has (title +
 *  dot-leader + label bundled together), unlike a single-MCID leaf. */
function buildRowLeaf(doc: PDFDocument, tag: string, mcids: number[]): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), K: doc.context.obj(mcids) }));
}

function buildSingleMcidLeaf(doc: PDFDocument, tag: string, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), K: mcid }));
}

/**
 * Real, trimmed shape from Karsaklian_189165_9781606497623.pdf's own page 7
 * content stream (see toc-entry-extractor.test.ts's own PAGE7_EXCERPT):
 * a page heading ("Contents", MCID 35), then one row -- "List of Figures
 * and Tables" / dot-leader / "ix" (36,37,38).
 */
const PAGE_CONTENT = `
/P <</Lang (en-US)/MCID 35 >>BDC
BT
24 0 0 24 185.0046 555.1201 Tm
(Contents)Tj
ET
EMC
/P <</Lang (en-US)/MCID 36 >>BDC
BT
10.5 0 0 10.5 84 513.1201 Tm
[(L)12 (ist of F)12 (igur)20 (es and )48 (T)130 (ables)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 37 >>BDC
BT
/Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 181.3334 513.1201 Tm
( )Tj
EMC
(.......................................................................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 38 >>BDC
BT
10.5 0 0 10.5 370.7657 513.1201 Tm
(ix)Tj
ET
EMC
`;

// PAGE_CONTENT above is heading + first row only (MCIDs 35-38) -- the
// page-9-shaped test below reuses it as-is (it builds its own second row
// group under a sub-heading instead). PAGE_CONTENT_FULL adds the second
// "Description"/"xi" row (39-41) for the two-row tests.
const PAGE_CONTENT_FULL = PAGE_CONTENT + `
/P <</Lang (en-US)/MCID 39 >>BDC
BT
10.5 0 0 10.5 84 498.1201 Tm
[(D)6 (escription)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 40 >>BDC
BT
/Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 128.2569 498.1201 Tm
( )Tj
EMC
(........................................................................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 41 >>BDC
BT
10.5 0 0 10.5 370.7657 498.1201 Tm
(xi)Tj
ET
EMC
`;

/**
 * Document -> Sect (parent) -> [heading leaf, row1 leaf, row2 leaf], with
 * page 1's content stream set to PAGE_CONTENT -- the real page-7 shape.
 */
async function buildDoc(): Promise<{
  doc: PDFDocument;
  sectRef: PDFRef;
  headingRef: PDFRef;
  row1Ref: PDFRef;
  row2Ref: PDFRef;
}> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  writePageContent(doc, 1, PAGE_CONTENT_FULL);

  const headingRef = buildSingleMcidLeaf(doc, 'FRMH', 35);
  const row1Ref = buildRowLeaf(doc, 'CFM', [36, 37, 38]);
  const row2Ref = buildRowLeaf(doc, 'CFM', [39, 40, 41]);

  const sectRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([headingRef, row1Ref, row2Ref]) })
  );
  for (const kid of [headingRef, row1Ref, row2Ref]) {
    doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
    doc.context.lookup(kid, PDFDict).set(PDFName.of('Pg'), page.ref);
  }

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, sectRef, headingRef, row1Ref, row2Ref };
}

describe('PdfStructureWriterService.fixTocStructure', () => {
  it('fails cleanly when the issue has no pageNumber', async () => {
    const { doc } = await buildDoc();
    const issue = tocStructureIssue(1);
    delete (issue as { pageNumber?: unknown }).pageNumber;

    const result = pdfStructureWriterService.fixTocStructure(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('pageNumber');
  });

  it('fails cleanly when there is no structure tree root', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No structure tree root found');
  });

  it('fails cleanly when the page has no TOC row candidates at all', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    writePageContent(doc, 1, 'q /GS0 gs Q');
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    void page;

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No TOC row candidates');
  });

  it('wraps a contiguous run of two rows in one new /TOC, excluding the preceding page heading', async () => {
    const { doc, sectRef, headingRef, row1Ref, row2Ref } = await buildDoc();

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    expect(result.success).toBe(true);
    expect(result.after).toContain('1 new /TOC');
    expect(result.after).toContain('2 row(s)');

    // Sect's own /K: [heading, TOC] -- heading untouched, TOC replaces the
    // two-row run at its original position (right after the heading).
    const sectKids = kidsOf(doc, sectRef);
    expect(sectKids).toHaveLength(2);
    expect(sectKids[0].objectNumber).toBe(headingRef.objectNumber);
    expect(tagOf(doc, sectKids[0])).toBe('FRMH'); // heading is NOT a TOC row, left alone
    const tocRef = sectKids[1];
    expect(tagOf(doc, tocRef)).toBe('TOC');
    expect(parentOf(doc, tocRef)?.objectNumber).toBe(sectRef.objectNumber);

    const tociRefs = kidsOf(doc, tocRef);
    expect(tociRefs).toHaveLength(2);
    expect(tociRefs.map((r) => r.objectNumber)).toEqual([row1Ref.objectNumber, row2Ref.objectNumber]);
    for (const tociRef of tociRefs) {
      expect(tagOf(doc, tociRef)).toBe('TOCI');
      expect(parentOf(doc, tociRef)?.objectNumber).toBe(tocRef.objectNumber);
    }

    // Each row's own MCIDs are untouched -- no new MCID fabricated, no
    // content-stream byte touched.
    expect(mcidsOf(doc, row1Ref)).toEqual([36, 37, 38]);
    expect(mcidsOf(doc, row2Ref)).toEqual([39, 40, 41]);
  });

  it('produces two separate /TOC elements when a non-row sibling splits the run (page-9 shape: a sub-heading between two row groups)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    // Content stream: heading, row A, a sub-heading ("List of Tables"), row B.
    const content = PAGE_CONTENT + `
/P <</MCID 118 >>BDC
BT
(List of Tables)Tj
ET
EMC
/P <</Lang (en-US)/MCID 119 >>BDC
BT
10.5 0 0 10.5 84 400 Tm
[(T)12 (able 1)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 120 >>BDC
BT
10.5 0 0 10.5 180 400 Tm
(.....)Tj
ET
EMC
/P <</Lang (en-US)/MCID 121 >>BDC
BT
10.5 0 0 10.5 370 400 Tm
(99)Tj
ET
EMC
`;
    writePageContent(doc, 1, content);

    const headingRef = buildSingleMcidLeaf(doc, 'FRMH', 35);
    const rowARef = buildRowLeaf(doc, 'CFM', [36, 37, 38]);
    const subHeadingRef = buildSingleMcidLeaf(doc, 'H1A', 118);
    const rowBRef = buildRowLeaf(doc, 'CFTT', [119, 120, 121]);

    const sectRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([headingRef, rowARef, subHeadingRef, rowBRef]) })
    );
    for (const kid of [headingRef, rowARef, subHeadingRef, rowBRef]) {
      doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);
      doc.context.lookup(kid, PDFDict).set(PDFName.of('Pg'), page.ref);
    }
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]) })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    expect(result.success).toBe(true);
    expect(result.after).toContain('2 new /TOC');

    const sectKids = kidsOf(doc, sectRef);
    // [heading, TOC(rowA), subHeading, TOC(rowB)]
    expect(sectKids).toHaveLength(4);
    expect(tagOf(doc, sectKids[0])).toBe('FRMH');
    expect(tagOf(doc, sectKids[1])).toBe('TOC');
    expect(kidsOf(doc, sectKids[1]).map((r) => r.objectNumber)).toEqual([rowARef.objectNumber]);
    expect(sectKids[2].objectNumber).toBe(subHeadingRef.objectNumber);
    expect(tagOf(doc, sectKids[2])).toBe('H1A'); // sub-heading untouched, not wrapped
    expect(tagOf(doc, sectKids[3])).toBe('TOC');
    expect(kidsOf(doc, sectKids[3]).map((r) => r.objectNumber)).toEqual([rowBRef.objectNumber]);
  });

  it('declines a row whose matched struct element\'s own MCIDs don\'t align as a trailing suffix, without blocking the rows around it (splits the run instead)', async () => {
    const { doc, sectRef, row1Ref } = await buildDoc();

    // Corrupt row1's own /K so it no longer matches the content-stream-
    // derived MCID set for that row (simulates "title split across two
    // elements" -- this element now only owns the label, not the title).
    doc.context.lookup(row1Ref, PDFDict).set(PDFName.of('K'), doc.context.obj([38]));

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    // Row2 alone still forms its own run and gets fixed; row1 is declined
    // (and left completely untouched) -- overall success is still false
    // because a decline happened, even though the safe subset is committed.
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not match');

    expect(tagOf(doc, row1Ref)).toBe('CFM'); // untouched
    const sectKids = kidsOf(doc, sectRef);
    const tocRefs = sectKids.filter((r) => tagOf(doc, r) === 'TOC');
    expect(tocRefs).toHaveLength(1);
    expect(kidsOf(doc, tocRefs[0])).toHaveLength(1);
    expect(tagOf(doc, kidsOf(doc, tocRefs[0])[0])).toBe('TOCI');
  });

  it('declines a row whose label MCID is ambiguous (two struct elements both reference it)', async () => {
    const { doc, row1Ref } = await buildDoc();

    // A second, unrelated element also claims MCID 38 (row1's own label) --
    // appended directly under the same parent as row1.
    const decoyRef = buildSingleMcidLeaf(doc, 'P', 38);
    const parentRef = parentOf(doc, row1Ref)!;
    const parentDict = doc.context.lookup(parentRef, PDFDict);
    const existingK = parentDict.get(PDFName.of('K'));
    const entries = existingK instanceof PDFArray ? existingK.asArray() : [];
    parentDict.set(PDFName.of('K'), doc.context.obj([...entries, decoyRef]));
    doc.context.lookup(decoyRef, PDFDict).set(PDFName.of('P'), parentRef);

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous');
    expect(tagOf(doc, row1Ref)).toBe('CFM'); // untouched
  });

  it('rolls back cleanly on an injected failure -- restores the parent /K and every item\'s /S + /P, deletes every newly created element', async () => {
    const { doc, sectRef, row1Ref, row2Ref, headingRef } = await buildDoc();
    const originalSectKids = kidsOf(doc, sectRef).map((r) => r.objectNumber);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reachableSpy = vi.spyOn(pdfStructureWriterService as any, 'isReachableFromRoot').mockReturnValue(false);
    const registerSpy = vi.spyOn(doc.context, 'register');

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));

    reachableSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.error).toContain('not committing');

    expect(kidsOf(doc, sectRef).map((r) => r.objectNumber)).toEqual(originalSectKids);
    expect(tagOf(doc, row1Ref)).toBe('CFM');
    expect(tagOf(doc, row2Ref)).toBe('CFM');
    expect(parentOf(doc, row1Ref)?.objectNumber).toBe(sectRef.objectNumber);
    expect(parentOf(doc, row2Ref)?.objectNumber).toBe(sectRef.objectNumber);
    expect(tagOf(doc, headingRef)).toBe('FRMH');

    const createdRefs = registerSpy.mock.results
      .map((r) => r.value as PDFRef)
      .filter((ref) => {
        const dict = doc.context.lookup(ref, PDFDict);
        return dict instanceof PDFDict && dict.get(PDFName.of('S'))?.toString() === '/TOC';
      });
    expect(createdRefs.length).toBeGreaterThan(0);
    for (const ref of createdRefs) {
      const dict = doc.context.lookup(ref, PDFDict);
      expect(dict.get(PDFName.of('K'))).toBeUndefined();
      expect(dict.get(PDFName.of('P'))).toBeUndefined();
    }
  });

  it('preserves MCID -> struct-element resolution via /ParentTree after the fix (same object, new ancestor)', async () => {
    const { doc, row1Ref } = await buildDoc();

    const structTreeRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef;
    const pageArr = doc.context.obj([row1Ref, row1Ref, row1Ref]); // MCIDs 36,37,38 all -> row1Ref
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRaw, PDFDict).set(PDFName.of('ParentTree'), parentTree);

    const result = pdfStructureWriterService.fixTocStructure(doc, tocStructureIssue(1));
    expect(result.success).toBe(true);

    const resolvedPageArr = doc.context.lookup((parentTree as PDFDict).get(PDFName.of('Nums')), PDFArray);
    const resolvedPageEntry = doc.context.lookup(resolvedPageArr.get(1), PDFArray);
    expect(resolvedPageEntry.size()).toBe(3);
    for (let i = 0; i < 3; i++) {
      const resolvedRef = resolvedPageEntry.get(i) as PDFRef;
      expect(resolvedRef.objectNumber).toBe(row1Ref.objectNumber);
    }
    // Same object, now tagged /TOCI instead of /CFM.
    expect(tagOf(doc, row1Ref)).toBe('TOCI');
  });
});
