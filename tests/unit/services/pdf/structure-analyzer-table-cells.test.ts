/**
 * Regression coverage for TableInfo.cells being populated.
 *
 * detectTabularContent() (structure-analyzer.service.ts) always computed
 * column positions and row/bold info but hardcoded `cells: []`, discarding
 * the data it had already parsed. Every downstream consumer that reads
 * table.cells -- analyzeTableSummary, analyzeTableHeaders, formatTableAsText
 * in ai-analysis.service.ts -- silently no-ops on any table detected this
 * way (`if (table.cells.length === 0) return null`), which meant
 * TABLE-MISSING-SUMMARY (and friends) never got an AI-drafted suggestion at
 * all for structurally-detected tables. This is a real-extraction test (not
 * mocked): it builds a real grid of positioned text with pdf-lib and parses
 * it for real, since the bug is specifically in how per-item positions get
 * assembled into rows/columns.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { structureAnalyzerService } from '../../../../src/services/pdf/structure-analyzer.service';

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

async function buildGridPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  await drawGrid(doc);
  return Buffer.from(await doc.save());
}

/**
 * Attaches a minimal tagged structure tree declaring exactly one /Table with
 * a header row (/TR containing a /TH), so the PDF is detected as tagged and
 * enhanceTablesFromTags()'s tag-driven header detection fires -- independent
 * of the bold-text heuristic detectTabularContent() uses at initial-cell-
 * build time. The /TH carries a real /Pg (matching how Seam C's real tagging
 * always puts /Pg on some leaf descendant, even when /Table and its
 * ancestors have none) so the table resolves to a real page and gets
 * matched, rather than being correctly discarded as unresolvable.
 */
function attachTaggedTableWithHeaderRow(doc: PDFDocument): void {
  const pageRef = doc.getPages()[0].ref;
  const thDict = doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef });
  const trDict = doc.context.obj({ S: PDFName.of('TR'), K: [thDict] });
  const tableDict = doc.context.obj({ S: PDFName.of('Table'), K: [trDict] });
  const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
  const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
  const structTreeRootRef = doc.context.register(structTreeRootDict);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
}

describe('structureAnalyzerService table cell extraction', () => {
  it('populates TableInfo.cells for a detected grid of positioned text', async () => {
    const buffer = await buildGridPdf();
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'grid.pdf');

    try {
      const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });

      expect(structure.tables.length).toBe(1);
      const table = structure.tables[0];

      expect(table.cells.length).toBeGreaterThan(0);
      expect(table.rowCount).toBe(4);
      expect(table.columnCount).toBe(3);

      const textAt = (row: number, column: number) =>
        table.cells.find(c => c.row === row && c.column === column)?.text;

      expect(textAt(0, 0)).toBe('Name');
      expect(textAt(0, 1)).toBe('Age');
      expect(textAt(0, 2)).toBe('City');
      expect(textAt(1, 0)).toBe('Alice');
      expect(textAt(2, 1)).toBe('25');
      expect(textAt(3, 2)).toBe('SF');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }, 30000);

  /**
   * Regression coverage for TableCell.anchor (added for the MATTERHORN-15-001
   * from-scratch retagger's Phase 1 correlation spike). Anchors must
   * use the SAME {x, baselineY} convention pdf-contrast-writer.service.ts's
   * locateTextRun expects (raw PDF-space bottom-up baseline, i.e. the
   * source TextItem's own transform[5] -- not TextItem.position.y, which
   * this module deliberately flips to top-down for its own consumers). The
   * grid here is drawn with pdf-lib's own drawText(x, y), which places text
   * with its baseline directly at the given (bottom-up) y -- so a correct
   * anchor should land close to the exact x/y each cell's text was drawn
   * at, not the top-down-flipped position.y.
   */
  it('populates a {x, baselineY} anchor per cell, in locateTextRun\'s raw PDF-space convention', async () => {
    const buffer = await buildGridPdf();
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'grid-anchor.pdf');

    try {
      const structure = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });

      const table = structure.tables[0];
      // drawGrid: columns = [60, 200, 340]; row 0 drawn at y=500, each
      // subsequent row 20pt lower (y -= 20 per row, bottom-up PDF space).
      const expected: Array<{ row: number; column: number; x: number; y: number }> = [
        { row: 0, column: 0, x: 60, y: 500 },
        { row: 0, column: 2, x: 340, y: 500 },
        { row: 2, column: 1, x: 200, y: 460 },
        { row: 3, column: 2, x: 340, y: 440 },
      ];

      for (const { row, column, x, y } of expected) {
        const cell = table.cells.find(c => c.row === row && c.column === column);
        expect(cell?.anchor).toBeDefined();
        expect(cell!.anchor!.x).toBeCloseTo(x, 0);
        // A few points of tolerance for font metrics -- this is a real
        // extraction, not exact arithmetic.
        expect(Math.abs(cell!.anchor!.baselineY - y)).toBeLessThan(3);
      }

      // Every populated cell in a text-only grid like this one should have
      // an anchor -- buildTableCells only ever pushes a cell after at least
      // one TextItem was assigned to it.
      expect(table.cells.every(c => c.anchor !== undefined)).toBe(true);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }, 30000);

  it('marks row-0 cells as headers when tag data promotes hasHeaderRow after cells are built', async () => {
    const doc = await PDFDocument.create();
    await drawGrid(doc);
    attachTaggedTableWithHeaderRow(doc);
    const buffer = Buffer.from(await doc.save());

    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'tagged-grid.pdf');

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
      expect(structure.tables.length).toBe(1);
      const table = structure.tables[0];

      // Tag data (a /TH inside the /Table's /TR) is what promotes this --
      // the grid's row-0 text ("Name"/"Age"/"City") is not bold, so the
      // heuristic detectTabularContent() uses when it first builds cells
      // would say hasHeaderRow: false on its own.
      expect(table.hasHeaderRow).toBe(true);

      const headerCells = table.cells.filter(c => c.row === 0);
      expect(headerCells.length).toBeGreaterThan(0);
      for (const cell of headerCells) {
        expect(cell.isHeader).toBe(true);
      }
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }, 30000);
});
