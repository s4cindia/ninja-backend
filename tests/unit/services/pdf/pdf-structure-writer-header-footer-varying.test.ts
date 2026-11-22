/**
 * Tests for PdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent --
 * see header-footer-varying-content.ts's own header comment for the real
 * incident (Karsaklian_189165_9781606497623.pdf: a per-chapter running
 * head, letter-by-letter MCID-tagged, nested as a struct-element child of
 * an unrelated list item's /Lbl). Mechanics mirror
 * retagDecorativeFigureAsArtifact's already-proven pattern, generalized to
 * an array of MCIDs per occurrence and many page-occurrences per issue.
 */
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFNull } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueFor(region: 'header' | 'footer', pages: number[], element: string): AuditIssue {
  return {
    id: 'issue-1',
    source: 'pdf-header-footer-content',
    severity: 'minor',
    code: 'HEADER-FOOTER-VARYING-TAGGED-AS-CONTENT',
    message: 'test',
    element,
    context: `Region: ${region}; Pages: ${pages.join(', ')}`,
    matterhornCheckpoint: '01-001',
    matterhornHow: 'H',
  } as AuditIssue;
}

function kidsOf(doc: PDFDocument, ref: PDFRef): PDFRef[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray().filter((x): x is PDFRef => x instanceof PDFRef) : [];
}

/** Minimal, test-only mirror of the writer's own private resolveParentTreePageArray, for a flat (non-Kids-tree) /Nums array built by setFlatParentTree below. */
function lookupParentTreePageArray(doc: PDFDocument, structTreeRootRef: PDFRef, pageKey: number): PDFArray {
  const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
  const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
  const parentTree = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw, PDFDict) : (parentTreeRaw as PDFDict);
  const numsRaw = parentTree.get(PDFName.of('Nums'));
  const numsArr = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw, PDFArray) : (numsRaw as PDFArray);
  const raw = numsArr.asArray();
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i];
    if (key instanceof PDFNumber && key.asNumber() === pageKey) {
      const valRaw = raw[i + 1];
      return valRaw instanceof PDFRef ? doc.context.lookup(valRaw, PDFArray) : (valRaw as PDFArray);
    }
  }
  throw new Error(`No ParentTree entry for page key ${pageKey}`);
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, pageKey: number, entries: PDFRef[]): void {
  const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
  const existing = structRoot.get(PDFName.of('ParentTree'));
  const numsArr = existing instanceof PDFDict ? existing.get(PDFName.of('Nums')) : undefined;
  const nums: unknown[] = numsArr instanceof PDFArray ? numsArr.asArray() : [];
  nums.push(doc.context.obj(pageKey), doc.context.obj(entries));
  structRoot.set(PDFName.of('ParentTree'), doc.context.obj({ Nums: nums }));
}

/** One page: [left P (mcid 0)] [running head Span, mcids 1-2, drawn in the header band] [right P (mcid 3)], all direct children of one parent. */
async function buildOnePageDoc(): Promise<{
  doc: PDFDocument;
  parentRef: PDFRef;
  leftRef: PDFRef;
  runningHeadRef: PDFRef;
  rightRef: PDFRef;
  structTreeRootRef: PDFRef;
}> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  writePageContent(
    doc,
    1,
    '/P <</MCID 0>> BDC (Left)Tj EMC\n' +
    '/Span <</MCID 1>> BDC\nBT\n1 0 0 1 60 550 Tm\n(Ru)Tj\nET\nEMC\n' +
    '/Span <</MCID 2>> BDC\nBT\n1 0 0 1 90 550 Tm\n(nning Head)Tj\nET\nEMC\n' +
    '/P <</MCID 3>> BDC (Right)Tj EMC\n'
  );

  const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 0 }));
  const runningHeadRef = doc.context.register(doc.context.obj({
    Type: PDFName.of('StructElem'), S: PDFName.of('Span'), Pg: page.ref, K: doc.context.obj([1, 2]),
  }));
  const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 3 }));
  const parentRef = doc.context.register(doc.context.obj({
    Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, runningHeadRef, rightRef],
  }));
  doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), parentRef);
  doc.context.lookup(runningHeadRef, PDFDict).set(PDFName.of('P'), parentRef);
  doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), parentRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [parentRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, 0, [leftRef, runningHeadRef, runningHeadRef, rightRef]);

  return { doc, parentRef, leftRef, runningHeadRef, rightRef, structTreeRootRef };
}

describe('fixHeaderFooterVaryingTaggedAsContent', () => {
  it('retags every MCID of the confirmed occurrence as /Artifact, removes the struct element, and nulls its ParentTree slots', async () => {
    const { doc, parentRef, leftRef, runningHeadRef, rightRef, structTreeRootRef } = await buildOnePageDoc();

    const result = pdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent(
      doc,
      issueFor('header', [1], 'running head')
    );

    expect(result.success).toBe(true);
    expect(result.after).toContain('1 occurrence');

    // Parent no longer holds the running head -- only left/right remain, in order.
    const kids = kidsOf(doc, parentRef);
    expect(kids.map((r) => r.objectNumber)).toEqual([leftRef.objectNumber, rightRef.objectNumber]);

    // The running head's own struct element is stripped (orphaned, not dangling).
    const rhDict = doc.context.lookup(runningHeadRef, PDFDict);
    expect(rhDict.get(PDFName.of('K'))).toBeUndefined();
    expect(rhDict.get(PDFName.of('P'))).toBeUndefined();

    // Content stream: both MCIDs retagged to bare /Artifact BMC.
    const content = decodePageContent(doc, 1);
    expect(content).toContain('/Artifact BMC');
    expect(content).not.toContain('/Span <</MCID 1>>');
    expect(content).not.toContain('/Span <</MCID 2>>');
    expect(content).toContain('/P <</MCID 0>>'); // untouched neighbor
    expect(content).toContain('/P <</MCID 3>>'); // untouched neighbor

    // ParentTree slots for MCIDs 1 and 2 are nulled; 0 and 3 untouched.
    const pageArr = lookupParentTreePageArray(doc, structTreeRootRef, 0);
    expect(pageArr.get(0)).toBeInstanceOf(PDFRef);
    expect(pageArr.get(1)).toBe(PDFNull);
    expect(pageArr.get(2)).toBe(PDFNull);
    expect(pageArr.get(3)).toBeInstanceOf(PDFRef);
  });

  it('declines a page whose claimed occurrence can no longer be found, without touching other pages that do still match', async () => {
    const { doc, parentRef, leftRef, runningHeadRef, rightRef } = await buildOnePageDoc();

    // Issue claims pages 1 AND 2, but this doc only has page 1 -- page 2
    // can never resolve a matching candidate.
    const result = pdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent(
      doc,
      issueFor('header', [1, 2], 'running head')
    );

    expect(result.success).toBe(false);
    expect(result.after).toContain('1/2 page(s) fixed');
    expect(result.error).toContain('page 2');

    // Page 1's own fix still committed even though the overall result is a failure.
    const kids = kidsOf(doc, parentRef);
    expect(kids.map((r) => r.objectNumber)).toEqual([leftRef.objectNumber, rightRef.objectNumber]);
    const rhDict = doc.context.lookup(runningHeadRef, PDFDict);
    expect(rhDict.get(PDFName.of('K'))).toBeUndefined();
  });

  it('declines cleanly (no mutation) when the issue\'s own text no longer matches any current candidate', async () => {
    const { doc, parentRef, leftRef, runningHeadRef, rightRef } = await buildOnePageDoc();

    const result = pdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent(
      doc,
      issueFor('header', [1], 'some other text entirely')
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no matching occurrence found');

    // No mutation at all.
    const kids = kidsOf(doc, parentRef);
    expect(kids.map((r) => r.objectNumber)).toEqual([leftRef.objectNumber, runningHeadRef.objectNumber, rightRef.objectNumber]);
  });

  it('fails cleanly when the issue context is not in the expected form', async () => {
    const { doc } = await buildOnePageDoc();
    const badIssue = { ...issueFor('header', [1], 'running head'), context: 'not the right shape' };
    const result = pdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent(doc, badIssue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expected');
  });

  it('rolls back this page\'s content-stream edit if a later mutation step throws, leaving the page unfixed and no other page affected', async () => {
    const { doc } = await buildOnePageDoc();
    const originalContent = decodePageContent(doc, 1);

    const spy = vi.spyOn(pdfStructureWriterService, 'deleteElement').mockImplementationOnce(() => {
      throw new Error('forced failure');
    });

    const result = pdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent(
      doc,
      issueFor('header', [1], 'running head')
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('forced failure');
    // Content stream restored to its original bytes.
    expect(decodePageContent(doc, 1)).toBe(originalContent);

    spy.mockRestore();
  });
});
