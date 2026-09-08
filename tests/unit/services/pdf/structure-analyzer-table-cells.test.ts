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
 * build time.
 */
function attachTaggedTableWithHeaderRow(doc: PDFDocument): void {
  const thDict = doc.context.obj({ S: PDFName.of('TH') });
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
