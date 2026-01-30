/**
 * Tests for PDF Table Validator
 *
 * Tests validation of table accessibility in PDF documents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pdfTableValidator } from '../../../../src/services/pdf/validators/pdf-table.validator';
import { structureAnalyzerService, DocumentStructure, TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

// Mock dependencies
vi.mock('../../../../src/services/pdf/structure-analyzer.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');

describe('PDFTableValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateFromFile', () => {
    it('should validate a PDF with well-structured tables', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, true, false, true), // Good data table
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      // Well-structured table should have minimal issues (maybe minor for missing summary)
      expect(result.metadata.totalTables).toBe(1);
      expect(result.metadata.tablesWithHeaders).toBe(1);
      expect(result.metadata.dataTables).toBe(1);
    });

    it('should identify critical issue for untagged table in tagged PDF', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false, ['Table not tagged']),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.summary.critical).toBe(1);

      const untaggedIssue = result.issues.find(i => i.code === 'MATTERHORN-15-001');
      expect(untaggedIssue).toBeDefined();
      expect(untaggedIssue?.severity).toBe('critical');
      expect(untaggedIssue?.message).toContain('not properly tagged');
      expect(untaggedIssue?.wcagCriteria).toContain('1.3.1');
    });

    it('should identify serious issue for table without headers', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false), // No headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.summary.serious).toBeGreaterThan(0);

      const noHeadersIssue = result.issues.find(i => i.code === 'MATTERHORN-15-002');
      expect(noHeadersIssue).toBeDefined();
      expect(noHeadersIssue?.severity).toBe('serious');
      expect(noHeadersIssue?.message).toContain('no headers');
      expect(noHeadersIssue?.wcagCriteria).toContain('1.3.1');
    });

    it('should identify moderate issue for incomplete headers on complex table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 10, 8, true, false, false), // Only header row, no header column
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const incompleteHeadersIssue = result.issues.find(i => i.code === 'TABLE-HEADERS-INCOMPLETE');
      expect(incompleteHeadersIssue).toBeDefined();
      expect(incompleteHeadersIssue?.severity).toBe('moderate');
      expect(incompleteHeadersIssue?.message).toContain('only has header row');
    });

    it('should identify moderate issue for missing scope attribute', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 5, true, false, false), // Medium size table with headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const scopeIssue = result.issues.find(i => i.code === 'MATTERHORN-15-004');
      expect(scopeIssue).toBeDefined();
      expect(scopeIssue?.severity).toBe('moderate');
      expect(scopeIssue?.message).toContain('scope attribute');
    });

    it('should identify serious issue for irregular table structure', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, true, false, false, ['Irregular structure detected']),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const irregularIssue = result.issues.find(i => i.code === 'MATTERHORN-15-003');
      expect(irregularIssue).toBeDefined();
      expect(irregularIssue?.severity).toBe('serious');
      expect(irregularIssue?.message).toContain('irregular structure');
      expect(irregularIssue?.wcagCriteria).toContain('1.3.1');
      expect(irregularIssue?.wcagCriteria).toContain('1.3.2');
    });

    it('should identify minor issue for missing summary on complex table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 10, 6, true, false, false), // Large table without summary
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const summaryIssue = result.issues.find(i => i.code === 'TABLE-MISSING-SUMMARY');
      expect(summaryIssue).toBeDefined();
      expect(summaryIssue?.severity).toBe('minor');
      expect(summaryIssue?.message).toContain('lacks summary or caption');
    });

    it('should not flag small tables for missing summary', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 3, 2, true, false, false), // Small table
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const summaryIssue = result.issues.find(i => i.code === 'TABLE-MISSING-SUMMARY');
      expect(summaryIssue).toBeUndefined();
    });
  });

  describe('layout table detection', () => {
    it('should detect single-column table as layout table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 1, false, false, false), // Single column, no headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.layoutTables).toBe(1);
      expect(result.metadata.dataTables).toBe(0);

      const layoutIssue = result.issues.find(i => i.code === 'MATTERHORN-15-005');
      expect(layoutIssue).toBeDefined();
      expect(layoutIssue?.message).toContain('layout table');
    });

    it('should detect single-row table as layout table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 1, 5, false, false, false), // Single row, no headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.layoutTables).toBe(1);
    });

    it('should detect small table without headers as potential layout table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 2, 2, false, false, false), // 2x2 table, no headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.layoutTables).toBeGreaterThan(0);
    });

    it('should not detect table with headers as layout table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 3, 3, true, false, false), // Has header row
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.dataTables).toBe(1);
      expect(result.metadata.layoutTables).toBe(0);
    });

    it('should not detect table with summary as layout table', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 2, 2, false, false, true), // Has summary
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.dataTables).toBe(1);
      expect(result.metadata.layoutTables).toBe(0);
    });
  });

  describe('WCAG and Matterhorn mapping', () => {
    it('should map structure issues to WCAG 1.3.1', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false), // No headers
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      for (const issue of result.issues) {
        expect(issue.wcagCriteria).toContain('1.3.1');
      }
    });

    it('should map irregular structure to both WCAG 1.3.1 and 1.3.2', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, true, false, false, ['Irregular structure']),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      const irregularIssue = result.issues.find(i => i.code === 'MATTERHORN-15-003');
      expect(irregularIssue?.wcagCriteria).toContain('1.3.1');
      expect(irregularIssue?.wcagCriteria).toContain('1.3.2');
    });

    it('should use correct Matterhorn checkpoints', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false, ['Table not tagged']), // 15-001
        createMockTable(2, 0, 5, 3, false, false, false), // 15-002
        createMockTable(3, 0, 1, 5, false, false, false), // 15-005 (layout)
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.some(i => i.code === 'MATTERHORN-15-001')).toBe(true);
      expect(result.issues.some(i => i.code === 'MATTERHORN-15-002')).toBe(true);
      expect(result.issues.some(i => i.code === 'MATTERHORN-15-005')).toBe(true);
    });
  });

  describe('metadata calculation', () => {
    it('should correctly calculate table metadata', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, true, false, true), // Has headers and summary
        createMockTable(2, 0, 5, 3, false, false, false), // No headers, no summary
        createMockTable(3, 0, 1, 5, false, false, false), // Layout table
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.metadata.totalTables).toBe(3);
      expect(result.metadata.tablesWithHeaders).toBe(1);
      expect(result.metadata.tablesWithoutHeaders).toBe(2);
      expect(result.metadata.tablesWithSummary).toBe(1);
      expect(result.metadata.layoutTables).toBe(1);
      expect(result.metadata.dataTables).toBe(2);
    });
  });

  describe('summary calculation', () => {
    it('should correctly calculate issue summary', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false, ['Table not tagged']), // Critical
        createMockTable(2, 0, 5, 3, false, false, false), // Serious (no headers)
        createMockTable(3, 0, 10, 8, true, false, false), // Moderate (incomplete headers)
        createMockTable(4, 0, 10, 6, true, false, false), // Minor (missing summary)
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      expect(result.summary.critical).toBeGreaterThan(0);
      expect(result.summary.serious).toBeGreaterThan(0);
      expect(result.summary.moderate).toBeGreaterThan(0);
      expect(result.summary.minor).toBeGreaterThan(0);
      expect(result.summary.total).toBe(result.issues.length);
    });
  });

  describe('table dimensions in messages', () => {
    it('should include table dimensions in all issue messages', async () => {
      const mockParsedPdf = createMockParsedPdf(true);
      const mockStructure = createMockStructure([
        createMockTable(1, 0, 5, 3, false, false, false), // 5x3 table
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfTableValidator.validateFromFile('/path/to/test.pdf');

      for (const issue of result.issues) {
        expect(issue.message).toMatch(/\d+×\d+/); // Contains "NxN" pattern
      }
    });
  });
});

// Helper functions to create mock data

function createMockParsedPdf(isTagged: boolean): ParsedPDF {
  return {
    structure: {
      pageCount: 10,
      metadata: {
        isTagged,
        language: 'en',
        title: 'Test Document',
        suspect: false,
        hasAcroForm: false,
      },
      outline: [],
    },
    pdfLibDoc: {} as ParsedPDF['pdfLibDoc'],
    pdfjsDoc: {} as ParsedPDF['pdfjsDoc'],
  };
}

function createMockTable(
  pageNumber: number,
  index: number,
  rowCount: number,
  columnCount: number,
  hasHeaderRow: boolean,
  hasHeaderColumn: boolean,
  hasSummary: boolean,
  issues: string[] = []
): TableInfo {
  return {
    id: `table_p${pageNumber}_${index}`,
    pageNumber,
    position: { x: 50, y: 100, width: 500, height: 300 },
    rowCount,
    columnCount,
    hasHeaderRow,
    hasHeaderColumn,
    hasSummary,
    summary: hasSummary ? 'Table showing data' : undefined,
    caption: undefined,
    cells: [],
    issues,
    isAccessible: hasHeaderRow || hasHeaderColumn,
  };
}

function createMockStructure(tables: TableInfo[]): DocumentStructure {
  return {
    isTaggedPDF: true,
    headings: {
      headings: [],
      hasProperHierarchy: true,
      hasH1: true,
      multipleH1: false,
      skippedLevels: [],
      issues: [],
    },
    tables,
    lists: [],
    links: [],
    readingOrder: {
      isLogical: true,
      hasStructureTree: true,
      issues: [],
      confidence: 0.9,
    },
    language: {
      documentLanguage: 'en',
      hasDocumentLanguage: true,
      languageChanges: [],
      issues: [],
    },
    bookmarks: [],
    formFields: [],
    accessibilityScore: 85,
    summary: {
      totalHeadings: 0,
      totalTables: tables.length,
      totalLists: 0,
      totalLinks: 0,
      totalImages: 0,
      totalFormFields: 0,
      criticalIssues: 0,
      majorIssues: 0,
      minorIssues: 0,
    },
  };
}
