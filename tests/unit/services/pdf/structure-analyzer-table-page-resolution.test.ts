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
import { structureAnalyzerService, TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const structureAnalyzerAny = structureAnalyzerService as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const structureWriterAny = pdfStructureWriterService as any;

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

  /**
   * Regression for a third bug in this same file, found investigating why a
   * fresh audit of a real 805-page document still had 79 of 197 open
   * table-header issues (40%) failing findTargetTable -- ALL with the
   * identical signature "zero /Table elements resolve to this issue's own
   * claimed page", confirmed on the real document to be a genuinely
   * unfindable (page, index) pair, not a momentary miss.
   *
   * consumeNextTable's global-queue fallback (used whenever a struct
   * element's own resolved page has no layout-detected TableInfo still
   * queued for it -- the common case for a long table whose tagged rows
   * span many pages, since text-layout detection chunks one TableInfo per
   * page while the struct tree tags the whole thing as a single /Table
   * resolving to just one page) pairs that struct element with *any*
   * leftover TableInfo, regardless of the TableInfo's own (unrelated,
   * stale) pageNumber. The caller then stamps structureElementIndex
   * relative to the struct element's REAL resolved page, but (before this
   * fix) left TableInfo.pageNumber untouched -- so table.id ends up
   * combining a page number and an index from two different pages, a
   * combination no real struct element ever occupies.
   */
  it('re-homes a globally-fallback-matched TableInfo to the struct element\'s real page, not its own stale one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1 -- gets a real /Table, no layout-detected table of its own
    doc.addPage([400, 600]); // page 2 -- gets a real /Table, no layout-detected table of its own
    doc.addPage([400, 600]); // page 3 -- no real /Table at all

    const pageRefs = doc.getPages().map(p => p.ref);
    // Registered as real indirect objects (not left inline) -- pdf-structure-
    // writer.service.ts's traverseStructTree only visits a node reached via
    // an actual PDFRef (its callers need a real ref to mutate, e.g.
    // renameElement), so an inline dict here would silently never be found.
    const buildTable = (pageRef: (typeof pageRefs)[number]) => {
      const thDict = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
      const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [thDict] }));
      return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    };
    const tableARef = buildTable(pageRefs[0]); // resolves to page 1
    const tableBRef = buildTable(pageRefs[1]); // resolves to page 2
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableARef, tableBRef] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    // Two layout-detected TableInfo entries, BOTH claiming page 3 -- the page
    // with no real struct element at all, mirroring how a page-spanning
    // table's later chunks each get independently detected on pages that
    // have no /Table of their own. Neither can ever page-queue-match a real
    // struct element (no /Table resolves to page 3), so both can only be
    // consumed via the global-queue fallback.
    const makeTableInfo = (id: string): TableInfo => ({
      id, pageNumber: 3,
      position: { x: 0, y: 0, width: 100, height: 100 },
      rowCount: 2, columnCount: 2,
      hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
      cells: [], issues: [], isAccessible: false,
    });
    const tableInfos: TableInfo[] = [makeTableInfo('table_p3_0'), makeTableInfo('table_p3_1')];

    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, tableInfos);

    expect(tableInfos[0].structureMatched).toBe(true);
    expect(tableInfos[1].structureMatched).toBe(true);

    // Both were re-homed off the stale page 3 onto the real struct element's
    // own resolved page (1 and 2 respectively, in document order).
    expect(tableInfos[0].pageNumber).toBe(1);
    expect(tableInfos[0].structureElementIndex).toBe(0);
    expect(tableInfos[1].pageNumber).toBe(2);
    expect(tableInfos[1].structureElementIndex).toBe(0);

    // End-to-end: the id these corrected fields would produce must actually
    // resolve to the real, distinct struct element via the same production
    // lookup fixSimpleTableHeaders uses -- not fail, and not collide with
    // each other's element.
    const structRoot = structureWriterAny.getStructTreeRoot(doc);
    const idA = `table_p${tableInfos[0].pageNumber}_${tableInfos[0].structureElementIndex}`;
    const idB = `table_p${tableInfos[1].pageNumber}_${tableInfos[1].structureElementIndex}`;
    const foundA = structureWriterAny.findTargetTable(doc, structRoot, idA);
    const foundB = structureWriterAny.findTargetTable(doc, structRoot, idB);

    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
    expect(foundA).not.toBe(foundB);
  });

  /**
   * Regression for a fourth bug in this same file, root-caused live while
   * investigating why MATTERHORN-15-002 plateaued at exactly 32 issues with
   * zero movement across a full auto-remediation round despite the re-homing
   * fix above (three tests up) already being live: findTaggedTables seeded
   * its currentPage walk with the literal 1, so a /Table struct element
   * whose own /Pg, subtree (6-level search), AND entire ancestor chain all
   * lack /Pg silently "resolved" to a fabricated page 1 instead of staying
   * unresolved -- corrupting perPageTableIndex and producing ids like
   * table_p1_5 for tables that were never really on page 1 at all. Confirmed
   * on the real document via CloudWatch: table-header-fix repeatedly failed
   * to apply for exactly these fabricated ids with "No Table element found
   * matching \"table_p1_5\"", identical across rounds -- a permanent,
   * structural failure, not a transient miss. The fix seeds the walk with
   * null (genuinely unknown) instead of 1, and skips pairing entirely for a
   * /Table that never resolves to a real page.
   */
  it('leaves a /Table unmatched, not fabricated onto page 1, when no /Pg exists anywhere in its chain', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1 -- has a layout-detected table, but no real /Pg anywhere resolves here

    // No Pg anywhere in this subtree (not even a leaf) -- and no ancestor
    // (Document, StructTreeRoot) carries one either, mirroring a tagger that
    // omits /Pg entirely for a given table.
    const thDict = doc.context.register(doc.context.obj({ S: PDFName.of('TH') }));
    const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [thDict] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo: TableInfo = {
      id: 'table_p1_0', pageNumber: 1,
      position: { x: 0, y: 0, width: 100, height: 100 },
      rowCount: 2, columnCount: 2,
      hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
      cells: [], issues: [], isAccessible: false,
    };

    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    // Never paired with the unresolvable struct element -- not silently
    // stamped with a fabricated structureElementIndex on a fictional page 1.
    expect(tableInfo.structureMatched).toBeUndefined();
    expect(tableInfo.pageReassigned).toBeUndefined();
    expect(tableInfo.structureElementIndex).toBeUndefined();
    expect(tableInfo.pageNumber).toBe(1); // untouched original layout-detected value
  });

  /**
   * Regression coverage for TableInfo.tablesOnRealPage, added to let a
   * pageReassigned table's summary-drafting consumer (ai-analysis.service.ts's
   * analyzeTableSummaryFromRender) tell an unambiguous single-table real page
   * (safe to auto-apply a rendered summary to) from a genuinely multi-table
   * one (must stay guidance-only) -- see structure-analyzer.service.ts's
   * TableInfo.tablesOnRealPage doc comment.
   */
  it('stamps tablesOnRealPage with the true per-real-page /Table count, not the layout-detected count', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1 -- exactly one real /Table
    doc.addPage([400, 600]); // page 2 -- two real /Table elements

    const pageRefs = doc.getPages().map(p => p.ref);
    const buildTable = (pageRef: (typeof pageRefs)[number]) => {
      const thDict = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
      const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [thDict] }));
      return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    };
    const tableOnPage1 = buildTable(pageRefs[0]);
    const tableOnPage2a = buildTable(pageRefs[1]);
    const tableOnPage2b = buildTable(pageRefs[1]);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableOnPage1, tableOnPage2a, tableOnPage2b] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const makeTableInfo = (id: string, pageNumber: number): TableInfo => ({
      id, pageNumber,
      position: { x: 0, y: 0, width: 100, height: 100 },
      rowCount: 2, columnCount: 2,
      hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
      cells: [], issues: [], isAccessible: false,
    });
    const tableInfos: TableInfo[] = [
      makeTableInfo('table_p1_0', 1),
      makeTableInfo('table_p2_0', 2),
      makeTableInfo('table_p2_1', 2),
    ];

    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, tableInfos);

    expect(tableInfos.every(t => t.structureMatched)).toBe(true);
    expect(tableInfos[0].tablesOnRealPage).toBe(1);
    expect(tableInfos[1].tablesOnRealPage).toBe(2);
    expect(tableInfos[2].tablesOnRealPage).toBe(2);
  });
});
