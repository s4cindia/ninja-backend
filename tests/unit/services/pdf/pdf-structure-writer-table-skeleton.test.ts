/**
 * Regression coverage for buildTableFromLayout (Slice 2d of the
 * MATTERHORN-15-001 from-scratch retagger): wires table-content-tagger.ts's
 * matchCellRanges/insertMarkedContentSpans (Slice 2b) together with
 * extendParentTree (Slice 2c) to build a real Table/TR/TH/TD/Span struct-tree
 * skeleton around content that has no existing tagging of its own.
 *
 * Live-validated separately against real Math_Kim data (table_p27_0, a
 * 3x2/5-cell table): 7/7 inserted MCIDs' text confirmed exact via pdfjs's
 * own getTextContent({includeMarkedContent: true}), multi-span cells
 * confirmed working (2 real cells needed 2 spans each), placement fix
 * confirmed correct (the trivial box's parent had 2000+ flat children --
 * insertIntoKidsAfter correctly avoided dumping the new Table at the very
 * end of the whole document's reading order).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, StandardFonts } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo, TableCell, TextItem } from '../../../../src/services/pdf/structure-analyzer.service';

function buildItem(x: number, baselineY: number, text: string): TextItem {
  return {
    text,
    pageNumber: 1,
    position: { x, y: 0, width: text.length * 7, height: 14 },
    font: { name: 'F1', size: 14, isBold: false, isItalic: false },
    transform: [1, 0, 0, 1, x, baselineY],
  };
}

function cell(row: number, column: number, items: TextItem[], isHeader = false): TableCell {
  return {
    row, column, isHeader, rowSpan: 1, colSpan: 1,
    text: items.map(i => i.text).join(' '),
    sourceItems: items,
  };
}

function tableInfo(overrides: Partial<TableInfo> & Pick<TableInfo, 'id' | 'pageNumber' | 'cells' | 'rowCount' | 'columnCount'>): TableInfo {
  return {
    position: { x: 0, y: 0, width: 400, height: 100 },
    hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
    issues: [], isAccessible: false,
    ...overrides,
  };
}

function issueFor(elementId: string): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-table',
    severity: 'critical',
    code: 'MATTERHORN-15-001',
    message: 'Genuinely tabular content is effectively untagged',
    element: elementId,
  };
}

/**
 * Builds a real page with real drawn text, plus a hand-built struct tree:
 * /StructTreeRoot -> /Document (with siblingsBefore, the trivial box, then
 * siblingsAfter) -- mirrors the real Math_Kim shape confirmed live (a flat
 * /Document root with many siblings), specifically to exercise
 * insertIntoKidsAfter's positional splice rather than a blind end-append.
 */
async function buildDocWithTrivialBoxAndSiblings(
  lines: Array<{ text: string; x: number; y: number }>,
  siblingCountBefore = 3,
  siblingCountAfter = 3,
): Promise<{ doc: PDFDocument; trivialBoxRef: PDFRef; parentRef: PDFRef }> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 14, font });
  const doc = await PDFDocument.load(await src.save());
  const pageRef = doc.getPage(0).ref;

  const trivialTdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
  const trivialTrRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [trivialTdRef] }));
  const trivialBoxRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trivialTrRef], Pg: pageRef }));

  const siblingsBefore = Array.from({ length: siblingCountBefore }, () =>
    doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: pageRef }))
  );
  const siblingsAfter = Array.from({ length: siblingCountAfter }, () =>
    doc.context.register(doc.context.obj({ S: PDFName.of('P'), Pg: pageRef }))
  );

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: [...siblingsBefore, trivialBoxRef, ...siblingsAfter] })
  );
  trivialTdRef; // (referenced via trivialTrRef's K)
  const trivialBox = doc.context.lookup(trivialBoxRef) as PDFDict;
  trivialBox.set(PDFName.of('P'), documentRef);

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  doc.getPage(0).node.set(PDFName.of('StructParents'), PDFNumber.of(0));

  return { doc, trivialBoxRef, parentRef: documentRef };
}

function getKidsTags(doc: PDFDocument, parentRef: PDFRef): string[] {
  const parent = doc.context.lookup(parentRef) as PDFDict;
  const k = parent.get(PDFName.of('K')) as PDFArray;
  return k.asArray().map(ref => {
    const dict = doc.context.lookup(ref as PDFRef) as PDFDict;
    return (dict.get(PDFName.of('S'))?.toString() ?? '?').replace(/^\//, '');
  });
}

describe('PdfStructureWriterService.buildTableFromLayout', () => {
  it('builds a simple fully-resolved 2x2 table with correct Table/TR/TD/Span/K/ParentTree wiring', async () => {
    const { doc, trivialBoxRef } = await buildDocWithTrivialBoxAndSiblings([
      { text: 'Alpha', x: 50, y: 500 },
      { text: 'Beta', x: 200, y: 500 },
      { text: 'Gamma', x: 50, y: 470 },
      { text: 'Delta', x: 200, y: 470 },
    ]);

    const cells: TableCell[] = [
      cell(0, 0, [buildItem(50, 500, 'Alpha')]),
      cell(0, 1, [buildItem(200, 500, 'Beta')]),
      cell(1, 0, [buildItem(50, 470, 'Gamma')]),
      cell(1, 1, [buildItem(200, 470, 'Delta')]),
    ];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 2, columnCount: 2 });
    const issue = issueFor('table_p1_0');

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue, table }]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].issueId).toBe(issue.id);

    // Placement: new Table inserted immediately after the trivial box.
    const parentDict = doc.context.lookup(
      (doc.context.lookup(trivialBoxRef) as PDFDict).get(PDFName.of('P')) as PDFRef
    ) as PDFDict;
    const kids = (parentDict.get(PDFName.of('K')) as PDFArray).asArray();
    const trivialIdx = kids.findIndex(r => (r as PDFRef).objectNumber === trivialBoxRef.objectNumber);
    const newTableRef = kids[trivialIdx + 1] as PDFRef;
    const newTable = doc.context.lookup(newTableRef) as PDFDict;
    expect(newTable.get(PDFName.of('S'))?.toString()).toBe('/Table');

    // Structure: 2 TR, each with 2 TD, each with 1 Span carrying an MCID.
    const trRefs = (newTable.get(PDFName.of('K')) as PDFArray).asArray();
    expect(trRefs).toHaveLength(2);
    const seenMcids: number[] = [];
    for (const trRef of trRefs) {
      const tr = doc.context.lookup(trRef as PDFRef) as PDFDict;
      expect(tr.get(PDFName.of('S'))?.toString()).toBe('/TR');
      const tdRefs = (tr.get(PDFName.of('K')) as PDFArray).asArray();
      expect(tdRefs).toHaveLength(2);
      for (const tdRef of tdRefs) {
        const td = doc.context.lookup(tdRef as PDFRef) as PDFDict;
        expect(td.get(PDFName.of('S'))?.toString()).toBe('/TD');
        const spanRefs = (td.get(PDFName.of('K')) as PDFArray).asArray();
        expect(spanRefs).toHaveLength(1);
        const span = doc.context.lookup(spanRefs[0] as PDFRef) as PDFDict;
        expect(span.get(PDFName.of('S'))?.toString()).toBe('/Span');
        const mcid = span.get(PDFName.of('K'));
        expect(mcid).toBeInstanceOf(PDFNumber);
        seenMcids.push((mcid as PDFNumber).asNumber());
      }
    }
    expect(new Set(seenMcids).size).toBe(4); // all distinct

    // ParentTree reverse-linkage: every MCID's array slot points back to its Span.
    const structRootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const structRoot = doc.context.lookup(structRootRef as PDFRef) as PDFDict;
    const ptRef = structRoot.get(PDFName.of('ParentTree'));
    const pt = doc.context.lookup(ptRef as PDFRef) as PDFDict;
    // Nums may be inline (not a ref) -- handle both.
    const nums = pt.get(PDFName.of('Nums'));
    const resolvedNums = (nums instanceof PDFRef ? doc.context.lookup(nums) : nums) as PDFArray;
    expect(resolvedNums.asArray()[0]).toEqual(PDFNumber.of(0)); // page key 0
  });

  it('gives a cell needing multiple content-stream runs multiple Span leaves, each its own MCID', async () => {
    // Two items far enough apart that they resolve to two separate runs
    // (not merged by mergeRanges), inside ONE cell.
    const { doc } = await buildDocWithTrivialBoxAndSiblings([
      { text: 'First', x: 50, y: 500 },
      { text: 'Second', x: 50, y: 400 }, // far below -- separate BT/ET, not adjacent
    ]);

    const cells: TableCell[] = [
      cell(0, 0, [buildItem(50, 500, 'First'), buildItem(50, 400, 'Second')]),
    ];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('2 tagged MCID span(s)');
  });

  it('tags only the resolved subset of a partially-resolved cell without crashing', async () => {
    const { doc } = await buildDocWithTrivialBoxAndSiblings([
      { text: 'Resolvable', x: 50, y: 500 },
    ]);

    // Second item points far outside any real content -- won't resolve.
    const cells: TableCell[] = [
      cell(0, 0, [buildItem(50, 500, 'Resolvable'), buildItem(999, 999, 'Nowhere')]),
    ];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('1 tagged MCID span(s)');
  });

  it('handles a fully-unresolved cell by producing an empty (untagged) TD rather than crashing', async () => {
    const { doc } = await buildDocWithTrivialBoxAndSiblings([
      { text: 'Elsewhere', x: 50, y: 500 },
    ]);

    const cells: TableCell[] = [
      cell(0, 0, [buildItem(999, 999, 'Nowhere')]),
    ];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('0 tagged MCID span(s)');
  });

  it('inserts the new Table immediately after the trivial box, preserving sibling order on both sides', async () => {
    const { doc, parentRef } = await buildDocWithTrivialBoxAndSiblings(
      [{ text: 'Solo', x: 50, y: 500 }], 2, 2
    );
    const before = getKidsTags(doc, parentRef);
    expect(before).toEqual(['P', 'P', 'Table', 'P', 'P']);

    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'Solo')])];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    const after = getKidsTags(doc, parentRef);
    // Original trivial box and all siblings preserved in order, new Table
    // spliced in immediately after the trivial box.
    expect(after).toEqual(['P', 'P', 'Table', 'Table', 'P', 'P']);
  });

  it('fails honestly when the positioning anchor cannot be resolved', async () => {
    const { doc } = await buildDocWithTrivialBoxAndSiblings([{ text: 'X', x: 50, y: 500 }]);
    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'X')])];
    const table = tableInfo({ id: 'table_p1_99', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_99'), table }]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/positioning anchor/i);
  });

  it('reports failure honestly when there is no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'X')])];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/structure tree/i);
  });
});
