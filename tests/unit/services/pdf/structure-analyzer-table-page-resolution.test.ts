/**
 * Regression coverage for table page resolution during tag-matching.
 *
 * Discovered via a real 805-page trial document: findTaggedTables() resolved
 * every /Table node's page via a hardcoded fallback of 1, never inheriting a
 * genuinely-resolved ancestor page (unlike traverseStructureTree, its sibling
 * used for headings, which threads currentPage correctly). Worse, the real
 * document's tagger (Seam C) puts /Pg on neither the /Table node nor any
 * ancestor up to /Document -- only on leaf row/cell descendants (e.g. the
 * first /TH) -- so even ancestor-inheritance alone wasn't enough; a subtree
 * search was required.
 *
 * The practical impact: perPageTableIndex/structureElementIndex collapsed
 * into one document-wide counter instead of a true per-page index, so
 * pdfModifierService.setTableSummary's page+index-based lookup (which parses
 * that same index back out of the table's id) almost never targeted the
 * table it was meant to -- across a real 10-round auto-remediation trial,
 * TABLE-MISSING-SUMMARY cleared only 3 of 144 flagged tables, even after
 * TableInfo.cells was fixed (a separate, prerequisite bug) to make
 * suggestions actually get drafted in the first place.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { structureAnalyzerService } from '../../../../src/services/pdf/structure-analyzer.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';

async function drawGrid(doc: PDFDocument) {
  const page = doc.addPage([400, 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const columns = [60, 200, 340];
  const rows = [
    ['Name', 'Age', 'City'],
    ['Alice', '30', 'NYC'],
    ['Bob', '25', 'LA'],
    ['Carol', '35', 'SF'],
  ];

  let y = 500;
  for (const row of rows) {
    row.forEach((text, i) => {
      page.drawText(text, { x: columns[i], y, size: 12, font, color: rgb(0, 0, 0) });
    });
    y -= 20;
  }
}

/**
 * Attaches two /Table structure elements, one per page, in a shape mirroring
 * Seam C's real tagging: /Pg lives only on the leaf /TH, absent from /Table,
 * /TR, /Document, and /StructTreeRoot.
 */
function attachTwoTaggedTablesOnePerPage(doc: PDFDocument): void {
  const pageRefs = doc.getPages().map(p => p.ref);

  const buildTable = (pageRef: (typeof pageRefs)[number]) => {
    const thDict = doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef });
    const trDict = doc.context.obj({ S: PDFName.of('TR'), K: [thDict] });
    return doc.context.obj({ S: PDFName.of('Table'), K: [trDict] });
  };

  const tableA = buildTable(pageRefs[0]);
  const tableB = buildTable(pageRefs[1]);
  const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableA, tableB] });
  const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
  const structTreeRootRef = doc.context.register(structTreeRootDict);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
}

describe('structureAnalyzerService table page resolution', () => {
  it('assigns each page its own independent structureElementIndex, and setTableSummary targets the right table', async () => {
    const doc = await PDFDocument.create();
    await drawGrid(doc); // page 1 (index 0)
    await drawGrid(doc); // page 2 (index 1)
    attachTwoTaggedTablesOnePerPage(doc);
    const buffer = Buffer.from(await doc.save());

    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'two-page-tables.pdf');

    try {
      const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });

      expect(structure.isTaggedPDF).toBe(true);
      expect(structure.tables.length).toBe(2);

      const tableOnPage1 = structure.tables.find(t => t.pageNumber === 1);
      const tableOnPage2 = structure.tables.find(t => t.pageNumber === 2);
      expect(tableOnPage1).toBeDefined();
      expect(tableOnPage2).toBeDefined();

      // Each page's first (only) table must independently be index 0 -- not
      // a document-wide counter that would make the second page's table 1.
      expect(tableOnPage1!.structureElementIndex).toBe(0);
      expect(tableOnPage2!.structureElementIndex).toBe(0);
      expect(tableOnPage1!.id).toBe('table_p1_0');
      expect(tableOnPage2!.id).toBe('table_p2_0');

      // The real-world consequence: applying a table-summary suggestion for
      // page 2's table must not silently land on page 1's table instead.
      const resultA = await pdfModifierService.setTableSummary(parsedPdf.pdfLibDoc, tableOnPage1!.id, 'Summary for page 1 table');
      const resultB = await pdfModifierService.setTableSummary(parsedPdf.pdfLibDoc, tableOnPage2!.id, 'Summary for page 2 table');

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(resultA.pageNumber).toBe(1);
      expect(resultB.pageNumber).toBe(2);

      // Re-analyze and confirm each table's own hasSummary/summary reflects
      // only its own write -- not swapped, not both, not neither.
      const reAnalyzed = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });
      const reTableOnPage1 = reAnalyzed.tables.find(t => t.pageNumber === 1);
      const reTableOnPage2 = reAnalyzed.tables.find(t => t.pageNumber === 2);
      expect(reTableOnPage1?.summary).toBe('Summary for page 1 table');
      expect(reTableOnPage2?.summary).toBe('Summary for page 2 table');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }, 30000);

  /**
   * Regression for a second, more dangerous bug found while investigating why
   * ~119-122 of 189 tables never received a summary despite ZERO apply-time
   * failures ever being logged across a real 20-round auto-remediation run:
   * setTableSummary silently fell back to tablesOnPage[0], then to the
   * GLOBAL tables[targetIndex]/tables[0] (any table, any page), whenever its
   * target page/index lookup came up empty -- always reporting success, so
   * the actually-flagged table's issue kept re-firing every round forever
   * while some unrelated table's summary got silently overwritten instead.
   *
   * Confirmed on the real document that this isn't a depth-limit bug: 14 of
   * 189 /Table elements have no /Pg anywhere in their entire subtree, even
   * searched with depth unbounded -- genuinely missing tag data, not
   * findable by raising resolveElementPageRef's maxDepth.
   */
  it('fails honestly instead of silently writing to a different table when the target page has none', async () => {
    const doc = await PDFDocument.create();
    await drawGrid(doc); // page 1 (index 0) -- the only page with a resolvable table
    await drawGrid(doc); // page 2 (index 1) -- deliberately has NO attached table at all

    const pageRefs = doc.getPages().map(p => p.ref);
    const thDict = doc.context.obj({ S: PDFName.of('TH'), Pg: pageRefs[0] });
    const trDict = doc.context.obj({ S: PDFName.of('TR'), K: [thDict] });
    const tableA = doc.context.obj({ S: PDFName.of('Table'), K: [trDict] });
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableA] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'one-resolvable-table.pdf');

    try {
      // Asks for page 2's table_p2_0 -- no /Table resolves to page 2 at all.
      const result = await pdfModifierService.setTableSummary(parsedPdf.pdfLibDoc, 'table_p2_0', 'Summary meant for a page-2 table');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Table element at page 2');

      // The real page-1 table must be untouched -- not silently given page
      // 2's summary via the tablesOnPage[0]/tables[0] fallback this removed.
      const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });
      const tableOnPage1 = structure.tables.find(t => t.pageNumber === 1);
      expect(tableOnPage1?.hasSummary).toBe(false);
      expect(tableOnPage1?.summary).toBeUndefined();
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }, 30000);
});
