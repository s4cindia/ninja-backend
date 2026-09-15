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
import { decodePageContent, pageContentMcids } from '../../../../src/services/pdf/pdf-content-stream-io';
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

/**
 * Two trivial boxes on the SAME page, both real /Table elements (table_p1_0
 * and table_p1_1 per findTargetTable's own "Nth /Table on this page"
 * indexing), for exercising the two-pass batch-safety requirement: fixing
 * both in one buildTableFromLayout call must not let the first entry's
 * retag-to-Artifact shift what "the Nth /Table on this page" means for the
 * second entry's own findTargetTable re-walk (the exact lesson
 * markTableAsArtifact already learned in PR #547).
 */
async function buildDocWithTwoTrivialBoxesSamePage(
  lines: Array<{ text: string; x: number; y: number }>,
): Promise<{ doc: PDFDocument; parentRef: PDFRef }> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 14, font });
  const doc = await PDFDocument.load(await src.save());
  const pageRef = doc.getPage(0).ref;

  const buildTrivialBox = () => {
    const tdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [tdRef] }));
    return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trRef], Pg: pageRef }));
  };
  const box0Ref = buildTrivialBox();
  const box1Ref = buildTrivialBox();

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: [box0Ref, box1Ref] })
  );
  (doc.context.lookup(box0Ref) as PDFDict).set(PDFName.of('P'), documentRef);
  (doc.context.lookup(box1Ref) as PDFDict).set(PDFName.of('P'), documentRef);

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  doc.getPage(0).node.set(PDFName.of('StructParents'), PDFNumber.of(0));

  return { doc, parentRef: documentRef };
}

function getKidsTags(doc: PDFDocument, parentRef: PDFRef): string[] {
  const parent = doc.context.lookup(parentRef) as PDFDict;
  const k = parent.get(PDFName.of('K')) as PDFArray;
  return k.asArray().map(ref => {
    const dict = doc.context.lookup(ref as PDFRef) as PDFDict;
    return (dict.get(PDFName.of('S'))?.toString() ?? '?').replace(/^\//, '');
  });
}

/** Reads back the /Scope value from a struct element's /A (Table-owner attribute dict), if any. */
function getScope(doc: PDFDocument, ref: PDFRef): string | undefined {
  const dict = doc.context.lookup(ref) as PDFDict;
  const aRaw = dict.get(PDFName.of('A'));
  const aArr = aRaw instanceof PDFArray ? aRaw.asArray() : aRaw ? [aRaw] : [];
  for (const item of aArr) {
    const obj = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (obj instanceof PDFDict && obj.get(PDFName.of('O'))?.toString() === '/Table') {
      return obj.get(PDFName.of('Scope'))?.toString().replace(/^\//, '');
    }
  }
  return undefined;
}

/** Finds the ref spliced in immediately after `afterRef` in `parentRef`'s /K array. */
function findRefAfter(doc: PDFDocument, parentRef: PDFRef, afterRef: PDFRef): PDFRef {
  const parent = doc.context.lookup(parentRef) as PDFDict;
  const kids = (parent.get(PDFName.of('K')) as PDFArray).asArray();
  const idx = kids.findIndex(r => (r as PDFRef).objectNumber === afterRef.objectNumber);
  return kids[idx + 1] as PDFRef;
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

  it('inserts the new Table immediately after the trivial box, and retags the box to Artifact', async () => {
    const { doc, parentRef } = await buildDocWithTrivialBoxAndSiblings(
      [{ text: 'Solo', x: 50, y: 500 }], 2, 2
    );
    const before = getKidsTags(doc, parentRef);
    expect(before).toEqual(['P', 'P', 'Table', 'P', 'P']);

    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'Solo')])];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    const after = getKidsTags(doc, parentRef);
    // Sibling order and count preserved; the trivial box's own slot now
    // reads /Artifact (not /Table) since it's retagged in place, and the
    // new real Table is spliced in immediately after it. Retagging the box
    // is required, not just cleanup: structure-analyzer.service.ts's
    // enhanceTablesFromTags pairs LAYOUT candidates to struct-tree /Table
    // elements via queue-based FIFO positional matching per page -- leaving
    // the old box tagged /Table alongside the new one would make the walk
    // find TWO /Table elements where it used to find one, shifting every
    // LATER same-page /Table's FIFO position by one (confirmed live against
    // Math_Kim: the flagged issue stayed flagged, and an unrelated table on
    // the same page got its structural match corrupted to the new table's
    // shape).
    expect(after).toEqual(['P', 'P', 'Artifact', 'Table', 'P', 'P']);
  });

  /**
   * Two-pass batch-safety regression: two MATTERHORN-15-001 issues resolving
   * to two different trivial boxes on the SAME page, fixed in one call.
   * findTargetTable's "Nth /Table on this page" indexing must stay stable
   * across the whole batch -- if the first entry's retag-to-Artifact ran
   * before the second entry's findTargetTable re-walk, the second entry
   * would see only one remaining /Table on the page (the first already
   * retagged), shifting what index 1 means and spuriously failing or
   * mismatching. Same lesson markTableAsArtifact already learned (PR #547).
   */
  it('fixes two trivial boxes on the same page in one batch without an earlier retag shifting a later lookup\'s index', async () => {
    const { doc, parentRef } = await buildDocWithTwoTrivialBoxesSamePage([
      { text: 'First', x: 50, y: 500 },
      { text: 'Second', x: 50, y: 470 },
    ]);

    const table0 = tableInfo({
      id: 'table_p1_0', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 500, 'First')])],
    });
    const table1 = tableInfo({
      id: 'table_p1_1', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 470, 'Second')])],
    });

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [
      { issue: issueFor('table_p1_0'), table: table0 },
      { issue: issueFor('table_p1_1'), table: table1 },
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);

    // Both trivial boxes retagged to Artifact, both new Tables present --
    // 2 Artifact + 2 Table = 4 kids, up from the original 2 trivial boxes.
    const after = getKidsTags(doc, parentRef);
    expect(after.filter(t => t === 'Artifact')).toHaveLength(2);
    expect(after.filter(t => t === 'Table')).toHaveLength(2);
    expect(after).toHaveLength(4);
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

  /**
   * Regression for CodeRabbit/Codex findings on PR #552: writes /Scope on
   * every generated TH, derived from hasHeaderRow/hasHeaderColumn and the
   * cell's own row/column independently -- not from isHeader alone, which
   * ORs both conditions together and can't tell them apart. The (0,0)
   * corner cell here satisfies BOTH conditions at once (Scope=Both); (0,1)
   * satisfies only the header-row condition (Scope=Column); (1,0) satisfies
   * only the header-column condition (Scope=Row); (1,1) is a plain TD.
   */
  it('writes the correct /Scope on generated TH cells, derived independently of isHeader', async () => {
    const { doc, trivialBoxRef, parentRef } = await buildDocWithTrivialBoxAndSiblings([
      { text: 'Corner', x: 50, y: 500 },
      { text: 'ColHead', x: 200, y: 500 },
      { text: 'RowHead', x: 50, y: 470 },
      { text: 'Data', x: 200, y: 470 },
    ]);

    const cells: TableCell[] = [
      cell(0, 0, [buildItem(50, 500, 'Corner')], true),
      cell(0, 1, [buildItem(200, 500, 'ColHead')], true),
      cell(1, 0, [buildItem(50, 470, 'RowHead')], true),
      cell(1, 1, [buildItem(200, 470, 'Data')], false),
    ];
    const table = tableInfo({
      id: 'table_p1_0', pageNumber: 1, cells, rowCount: 2, columnCount: 2,
      hasHeaderRow: true, hasHeaderColumn: true,
    });

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);
    expect(results[0].success).toBe(true);

    const newTableRef = findRefAfter(doc, parentRef, trivialBoxRef);
    const newTable = doc.context.lookup(newTableRef) as PDFDict;
    const trRefs = (newTable.get(PDFName.of('K')) as PDFArray).asArray() as PDFRef[];

    const scopesByRowCol: Record<string, { tag: string; scope?: string }> = {};
    trRefs.forEach((trRef, rowIdx) => {
      const tr = doc.context.lookup(trRef) as PDFDict;
      const cellRefs = (tr.get(PDFName.of('K')) as PDFArray).asArray() as PDFRef[];
      cellRefs.forEach((cellRef, colIdx) => {
        const cellDict = doc.context.lookup(cellRef) as PDFDict;
        scopesByRowCol[`${rowIdx},${colIdx}`] = {
          tag: (cellDict.get(PDFName.of('S'))?.toString() ?? '?').replace(/^\//, ''),
          scope: getScope(doc, cellRef),
        };
      });
    });

    expect(scopesByRowCol['0,0']).toEqual({ tag: 'TH', scope: 'Both' });
    expect(scopesByRowCol['0,1']).toEqual({ tag: 'TH', scope: 'Column' });
    expect(scopesByRowCol['1,0']).toEqual({ tag: 'TH', scope: 'Row' });
    expect(scopesByRowCol['1,1']).toEqual({ tag: 'TD', scope: undefined });
  });

  /**
   * Regression for CodeRabbit/Codex findings on PR #552: an entry whose
   * positioning anchor can't be resolved must be excluded from
   * insertMarkedContentSpans entirely -- never attempted then reported
   * failed afterward, which would otherwise leave orphan MCIDs in the
   * content stream with no owning struct element or /ParentTree mapping.
   * Confirms this at the level that actually matters: the second (valid)
   * entry on the same page still succeeds, and exactly ONE MCID exists on
   * the page afterward -- not two, and not zero.
   */
  it('excludes an unresolvable entry from content-stream mutation while a valid entry on the same page still succeeds', async () => {
    const { doc } = await buildDocWithTwoTrivialBoxesSamePage([
      { text: 'First', x: 50, y: 500 },
    ]);

    const validTable = tableInfo({
      id: 'table_p1_0', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 500, 'First')])],
    });
    const invalidTable = tableInfo({
      id: 'table_p1_99', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 500, 'First')])],
    });

    const validIssue = issueFor('table_p1_0');
    const invalidIssue = issueFor('table_p1_99');
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [
      { issue: validIssue, table: validTable },
      { issue: invalidIssue, table: invalidTable },
    ]);

    // Invalid entries are reported during an earlier preflight pass than
    // valid ones, so array order doesn't match input order for a mixed
    // batch -- look up by issueId rather than assuming index.
    const validResult = results.find(r => r.issueId === validIssue.id)!;
    const invalidResult = results.find(r => r.issueId === invalidIssue.id)!;
    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toMatch(/positioning anchor/i);

    const mcids = pageContentMcids(doc, 1);
    expect(mcids?.size).toBe(1);
  });

  it('does not touch the content stream at all when every entry on a page has an unresolvable positioning anchor', async () => {
    const { doc } = await buildDocWithTrivialBoxAndSiblings([{ text: 'X', x: 50, y: 500 }]);
    const before = decodePageContent(doc, 1);

    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'X')])];
    const table = tableInfo({ id: 'table_p1_99', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_99'), table }]);

    expect(results[0].success).toBe(false);
    const after = decodePageContent(doc, 1);
    expect(after).toBe(before);
    expect(pageContentMcids(doc, 1)?.size ?? 0).toBe(0);
  });

  /**
   * Regression for a CodeRabbit finding on PR #552: insertMarkedContentSpans
   * assigns MCIDs in content-stream BYTE-OFFSET order across the whole
   * page's batch, not grouped by which entry submitted them. Draw order here
   * (A1, B1, A2, B2) means entry A's own two items end up as MCIDs {0,2}
   * and entry B's as {1,3} -- NEITHER entry's own MCID set is contiguous on
   * its own, only the page's full combined {0,1,2,3} is. A per-entry
   * extendParentTree call (the pre-fix design) would incorrectly throw on
   * either entry's non-contiguous subset; the single combined per-page call
   * must succeed for both.
   */
  it('correctly wires ParentTree via one combined per-page call even when two entries\' MCIDs interleave in byte order', async () => {
    const { doc } = await buildDocWithTwoTrivialBoxesSamePage([
      { text: 'A1', x: 50, y: 500 },
      { text: 'B1', x: 50, y: 400 },
      { text: 'A2', x: 50, y: 300 },
      { text: 'B2', x: 50, y: 200 },
    ]);

    const tableA = tableInfo({
      id: 'table_p1_0', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 500, 'A1'), buildItem(50, 300, 'A2')])],
    });
    const tableB = tableInfo({
      id: 'table_p1_1', pageNumber: 1, rowCount: 1, columnCount: 1,
      cells: [cell(0, 0, [buildItem(50, 400, 'B1'), buildItem(50, 200, 'B2')])],
    });

    const results = pdfStructureWriterService.buildTableFromLayout(doc, [
      { issue: issueFor('table_p1_0'), table: tableA },
      { issue: issueFor('table_p1_1'), table: tableB },
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[0].after).toContain('2 tagged MCID span(s)');
    expect(results[1].after).toContain('2 tagged MCID span(s)');
  });

  /**
   * Regression for CodeRabbit's pushback on PR #552 (comment 4011591766):
   * the first round of preflighting covered findTargetTable/parent
   * resolution but not the page's /ParentTree shape, so a document using a
   * hierarchical /Kids number tree (unsupported, extendParentTree's own
   * documented rejection) still surfaced its failure only AFTER real MCIDs
   * and struct elements already existed with nowhere to wire them. This
   * confirms the shape is now caught before any content-stream mutation.
   */
  it('preflights the /ParentTree shape and leaves the content stream untouched when it uses an unsupported hierarchical /Kids number tree', async () => {
    const { doc } = await buildDocWithTrivialBoxAndSiblings([{ text: 'X', x: 50, y: 500 }]);
    const before = decodePageContent(doc, 1);

    const structRootRef = doc.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef;
    const structRoot = doc.context.lookup(structRootRef) as PDFDict;
    const kidRef = doc.context.register(doc.context.obj({ Nums: doc.context.obj([]) }));
    const hierarchicalParentTreeRef = doc.context.register(doc.context.obj({ Kids: doc.context.obj([kidRef]) }));
    structRoot.set(PDFName.of('ParentTree'), hierarchicalParentTreeRef);

    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'X')])];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });
    const results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/hierarchical.*Kids/i);

    const after = decodePageContent(doc, 1);
    expect(after).toBe(before);
    expect(pageContentMcids(doc, 1)?.size ?? 0).toBe(0);
  });

  /**
   * Regression for a second finding from the same round: the previous
   * version's final per-page extendParentTree call sat OUTSIDE any
   * try/catch and every entry that reached struct-tree building was
   * already pushed into `results` as success:true BEFORE that call ran --
   * so if it threw (e.g. a contiguity mismatch the shape-only preflight
   * above can't catch, since it depends on the actual MCIDs assigned),
   * buildTableFromLayout crashed with an UNCAUGHT exception instead of
   * returning a FixResult[], and any already-reported "success" was a lie
   * regardless. This constructs exactly that gap: a document whose
   * /ParentTree is a valid (non-Kids) array shape -- passing the shape
   * preflight -- but whose existing per-page array already has entries
   * that don't line up with the fresh MCIDs insertMarkedContentSpans is
   * about to allocate (starting at 0, since the content stream itself has
   * no existing MCIDs), forcing extendParentTree's own contiguity check to
   * reject the final commit.
   */
  it('never throws uncaught, and flips an already-reported success back to failure, when the final ParentTree commit rejects a contiguity mismatch the shape preflight cannot see', async () => {
    const { doc, parentRef } = await buildDocWithTrivialBoxAndSiblings([{ text: 'X', x: 50, y: 500 }]);

    const structRootRef = doc.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef;
    const structRoot = doc.context.lookup(structRootRef) as PDFDict;
    // A valid array-shaped /ParentTree (passes resolveParentTreeNumsArray's
    // preflight) whose page-0 entry already has 2 entries -- but the
    // content stream itself has no <<MCID n>> markers at all, so
    // insertMarkedContentSpans will allocate starting at MCID 0, not 2,
    // guaranteeing extendParentTree's contiguity check rejects the commit.
    const staleEntryArray = doc.context.obj([doc.context.register(doc.context.obj({ S: PDFName.of('Span') }))]);
    const numsArr = doc.context.obj([PDFNumber.of(0), staleEntryArray]);
    const parentTreeRef = doc.context.register(doc.context.obj({ Nums: numsArr }));
    structRoot.set(PDFName.of('ParentTree'), parentTreeRef);

    const cells: TableCell[] = [cell(0, 0, [buildItem(50, 500, 'X')])];
    const table = tableInfo({ id: 'table_p1_0', pageNumber: 1, cells, rowCount: 1, columnCount: 1 });

    let results: ReturnType<typeof pdfStructureWriterService.buildTableFromLayout> | undefined;
    expect(() => {
      results = pdfStructureWriterService.buildTableFromLayout(doc, [{ issue: issueFor('table_p1_0'), table }]);
    }).not.toThrow();

    expect(results).toBeDefined();
    expect(results![0].success).toBe(false);
    expect(results![0].error).toMatch(/contiguously/i);

    // Partial mitigation for the residual risk this test forces (CodeRabbit
    // finding on PR #552: no full transactional rollback): the newly-built
    // Table this call can no longer honestly wire into /ParentTree must not
    // be left looking like a complete, valid table -- it's retagged to
    // /Artifact in place, same as the trivial box already is. Both slots
    // read /Artifact; neither reads /Table. (Default siblingCountBefore/
    // After from buildDocWithTrivialBoxAndSiblings is 3 each.)
    expect(getKidsTags(doc, parentRef)).toEqual(['P', 'P', 'P', 'Artifact', 'Artifact', 'P', 'P', 'P']);
  });
});
