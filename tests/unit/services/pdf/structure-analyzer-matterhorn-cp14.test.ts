/**
 * Regression coverage for Matterhorn CP14 conditions 14-002/14-006/14-007
 * (structureAnalyzerService.analyzeHeadings / traverseStructureTree).
 *
 * Two CodeRabbit review findings on this fix's first version, both covered
 * here:
 *  1. 14-006 ("A node contains more than one H tag") counts DIRECT children
 *     tagged with the generic bare /H specifically -- confirmed against
 *     veraPDF's own real implementation of this rule -- NOT any numbered
 *     H1-H9 child, which the first version incorrectly also counted.
 *  2. 14-002 ("the first heading tag is not H1") reads the tag tree's own
 *     reading-order first heading (not the later position-sorted array),
 *     and compares the LITERAL tag against 'H1' (not the coerced numeric
 *     level, which treats bare /H as indistinguishable from H1).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { structureAnalyzerService } from '../../../../src/services/pdf/structure-analyzer.service';

async function buildPage(doc: PDFDocument): Promise<void> {
  const page = doc.addPage([400, 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Some page content', { x: 60, y: 500, size: 12, font, color: rgb(0, 0, 0) });
}

function setStructTree(doc: PDFDocument, documentKids: unknown[]): void {
  const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj(documentKids) });
  const documentRef = doc.context.register(documentDict);
  const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
  const structTreeRootRef = doc.context.register(structTreeRootDict);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
}

describe('structureAnalyzerService — Matterhorn 14-006 (a node has more than one direct H tag)', () => {
  it('fires when a node has two direct bare /H children', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 0 }));
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 1 }));
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([h1Ref, h2Ref]) }));
    setStructTree(doc, [sectRef]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'two-bare-h.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'multiple-headings-one-node')).toBe(true);
  });

  it('does not fire for a node with one bare /H and one numbered /H2 child', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const bareRef = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 0 }));
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 1 }));
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([bareRef, h2Ref]) }));
    setStructTree(doc, [sectRef]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'bare-plus-numbered.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'multiple-headings-one-node')).toBe(false);
  });

  it('does not fire for a node with two numbered H1/H2 children (only bare /H siblings are ambiguous)', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: 0 }));
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 1 }));
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([h1Ref, h2Ref]) }));
    setStructTree(doc, [sectRef]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'two-numbered.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'multiple-headings-one-node')).toBe(false);
  });
});

describe('structureAnalyzerService — Matterhorn 14-002 (first heading tag is not H1)', () => {
  it('fires when the document uses numbered headings but opens on bare /H (literal tag isn\'t "H1", even though its level coerces to 1)', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const bareRef = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 0 })); // first in reading order
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 1 })); // makes usesNumberedH true
    setStructTree(doc, [bareRef, h2Ref]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'opens-on-bare-h.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    const issue = headingHierarchy.issues.find(i => i.type === 'first-heading-not-h1');
    expect(issue).toBeTruthy();
    expect(issue!.description).toContain('is H,');
  });

  it('fires when the first numbered heading is H2, not H1', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 0 }));
    setStructTree(doc, [h2Ref]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'opens-on-h2.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'first-heading-not-h1')).toBe(true);
  });

  it('does not fire when the document uses ONLY bare /H throughout (condition requires "uses numbered headings")', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const bare1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 0 }));
    const bare2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 1 }));
    const sect1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: bare1Ref }));
    const sect2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: bare2Ref }));
    setStructTree(doc, [sect1Ref, sect2Ref]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'bare-h-only.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'first-heading-not-h1')).toBe(false);
  });

  it('does not fire when the first heading is literally H1', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: 0 }));
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 1 }));
    setStructTree(doc, [h1Ref, h2Ref]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'opens-on-h1.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'first-heading-not-h1')).toBe(false);
  });
});

describe('structureAnalyzerService — Matterhorn 14-007 (document uses both H and H# tags)', () => {
  it('fires when the document mixes bare /H and numbered /H1-/H9', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: 0 }));
    const bareRef = doc.context.register(doc.context.obj({ S: PDFName.of('H'), K: 1 }));
    setStructTree(doc, [h1Ref, bareRef]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'mixed-tag-types.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'mixed-heading-tag-types')).toBe(true);
  });

  it('does not fire when the document uses only numbered headings', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: 0 }));
    const h2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H2'), K: 1 }));
    setStructTree(doc, [h1Ref, h2Ref]);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'numbered-only.pdf');
    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.issues.some(i => i.type === 'mixed-heading-tag-types')).toBe(false);
  });
});
