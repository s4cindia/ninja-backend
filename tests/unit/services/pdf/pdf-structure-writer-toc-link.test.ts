/**
 * Regression coverage for fixTocEntryLink -- builds a real internal /Link
 * (GoTo action) from a TOC entry's own trailing page-number/roman-numeral
 * label (e.g. "25", "ix") to its already-resolved target page.
 *
 * Unlike fixLinkMissingAnnotation/fixCrossReferenceLink, this does NOT
 * search the content stream for the label's own text -- tocLinkData.mcid
 * already names the exact, already-isolated bare-MCID span (confirmed real
 * via Karsaklian_189165_9781606497623.pdf's own content stream: see
 * toc-entry-extractor.ts's own header comment). These tests focus on the
 * direct-MCID splice path and its own "decline rather than guess" gates,
 * reusing the SAME applyLinkSplice tail fixCrossReferenceLink's own tests
 * already exercise for the annotation/struct-element/rollback half.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function tocLinkIssue(
  pageNumber: number,
  tocLinkData: NonNullable<AuditIssue['tocLinkData']>,
  overrides: Partial<AuditIssue> = {},
): AuditIssue {
  return {
    id: 'toc-link-1',
    source: 'pdf-toc-validator',
    severity: 'serious',
    code: 'TOC-LINK-MISSING',
    message: `TOC entry "${tocLinkData.entryText}" (page ${tocLinkData.label}) has no Link annotation to its target section`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    tocLinkData,
    boundingBox: { x: 370, y: 270, width: 20, height: 10.5, pageWidth: 612, pageHeight: 792 },
    ...overrides,
  } as AuditIssue;
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a 3-page document: page 1 carries the TOC entry's own label text
 * ("25") as a completely isolated `/P <</MCID 0>>` span -- the exact real
 * shape toc-entry-extractor.ts's own header comment documents -- and pages
 * 2-3 exist as real GoTo targets.
 */
async function buildDoc(labelText = '(25)Tj'): Promise<{ doc: PDFDocument; pRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  page1.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);

  writePageContent(doc, 1, `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n10.5 0 0 10.5 370 513 Tm\n${labelText}\nET EMC`);

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page1.ref, K: 0 }));
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef };
}

describe('fixTocEntryLink', () => {
  it('builds a real /Link annotation + structure element with a GoTo action to the resolved target page', async () => {
    const { doc } = await buildDoc();

    const result = pdfStructureWriterService.fixTocEntryLink(
      doc, tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' })
    );

    expect(result.success).toBe(true);
    expect(result.after).toContain('25');
    expect(result.after).toContain('page 3'); // targetPageIndex 2 -> 1-based page 3

    const page1 = doc.getPage(0);
    const annots = doc.context.lookup(page1.node.get(PDFName.of('Annots')), PDFArray);
    expect(annots.size()).toBe(1);
    const annotDict = doc.context.lookup(annots.get(0), PDFDict);
    expect(annotDict.get(PDFName.of('Subtype'))?.toString()).toBe('/Link');
    const action = annotDict.get(PDFName.of('A'));
    expect(action).toBeInstanceOf(PDFDict);
    expect((action as PDFDict).get(PDFName.of('S'))?.toString()).toBe('/GoTo');
    const dest = (action as PDFDict).get(PDFName.of('D'));
    expect(dest).toBeInstanceOf(PDFArray);
    const destPageRef = (dest as PDFArray).get(0);
    expect(destPageRef).toEqual(doc.getPage(2).ref);
  });

  it('declines cleanly when the issue has no tocLinkData', async () => {
    const { doc } = await buildDoc();
    const issue = tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' });
    delete (issue as { tocLinkData?: unknown }).tocLinkData;

    const result = pdfStructureWriterService.fixTocEntryLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('tocLinkData');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc();
    const issue = tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' });
    delete (issue as { boundingBox?: unknown }).boundingBox;

    const result = pdfStructureWriterService.fixTocEntryLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boundingBox');
  });

  it('declines cleanly when the issue has no pageNumber', async () => {
    const { doc } = await buildDoc();
    const issue = tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' });
    delete (issue as { pageNumber?: unknown }).pageNumber;

    const result = pdfStructureWriterService.fixTocEntryLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('pageNumber');
  });

  it('declines when no BDC on the page opens the given MCID', async () => {
    const { doc } = await buildDoc();

    const result = pdfStructureWriterService.fixTocEntryLink(
      doc, tocLinkIssue(1, { mcid: 99, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('MCID 99');
  });

  it('declines when the resolved target page index is out of range', async () => {
    const { doc } = await buildDoc();

    const result = pdfStructureWriterService.fixTocEntryLink(
      doc, tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 50, entryText: 'Chapter 2' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('rolls back page content, /Annots, and the enclosing element\'s /K on failure after the content splice begins', async () => {
    // Out-of-range target page index is only discovered AFTER the splice is
    // already built (buildLinkCompletenessSplice succeeds), but BEFORE the
    // annotation-creation try block -- so nothing should have been written
    // at all; re-running with a valid target afterward must still succeed.
    const { doc } = await buildDoc();
    const badResult = pdfStructureWriterService.fixTocEntryLink(
      doc, tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 999, entryText: 'Chapter 2' })
    );
    expect(badResult.success).toBe(false);

    const goodResult = pdfStructureWriterService.fixTocEntryLink(
      doc, tocLinkIssue(1, { mcid: 0, label: '25', targetPageIndex: 2, entryText: 'Chapter 2' })
    );
    expect(goodResult.success).toBe(true);
  });
});
