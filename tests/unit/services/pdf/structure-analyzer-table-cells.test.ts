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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { structureAnalyzerService } from '../../../../src/services/pdf/structure-analyzer.service';

async function buildGridPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
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

  return Buffer.from(await doc.save());
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
});
