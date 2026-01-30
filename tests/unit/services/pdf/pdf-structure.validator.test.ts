/**
 * Tests for PDF Structure Validator
 *
 * Tests validation of PDF structure for accessibility compliance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pdfStructureValidator } from '../../../../src/services/pdf/validators/pdf-structure.validator';
import { structureAnalyzerService, DocumentStructure } from '../../../../src/services/pdf/structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

// Mock dependencies
vi.mock('../../../../src/services/pdf/structure-analyzer.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');

describe('PDFStructureValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateFromFile', () => {
    it('should validate a tagged PDF with no issues', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues).toHaveLength(0);
      expect(result.metadata.isTaggedPDF).toBe(true);
      expect(result.metadata.hasDocumentLanguage).toBe(true);
      expect(result.metadata.hasDocumentTitle).toBe(true);
      expect(pdfParserService.close).toHaveBeenCalledWith(mockParsedPdf);
    });

    it('should identify critical issue for untagged PDF', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.summary.critical).toBe(1);

      const taggedIssue = result.issues.find(i => i.code === 'MATTERHORN-01-003');
      expect(taggedIssue).toBeDefined();
      expect(taggedIssue?.severity).toBe('critical');
      expect(taggedIssue?.message).toContain('not tagged');
      expect(taggedIssue?.wcagCriteria).toContain('1.3.1');
    });

    it('should identify serious issue for missing document language', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: false,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: false,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const languageIssue = result.issues.find(i => i.code === 'MATTERHORN-11-001');
      expect(languageIssue).toBeDefined();
      expect(languageIssue?.severity).toBe('serious');
      expect(languageIssue?.message).toContain('language is not specified');
      expect(languageIssue?.wcagCriteria).toContain('3.1.1');
    });

    it('should identify serious issue for missing document title', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: false,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const titleIssue = result.issues.find(i => i.code === 'WCAG-2.4.2');
      expect(titleIssue).toBeDefined();
      expect(titleIssue?.severity).toBe('serious');
      expect(titleIssue?.message).toContain('title is not present');
      expect(titleIssue?.wcagCriteria).toContain('2.4.2');
    });
  });

  describe('heading validation', () => {
    it('should identify missing H1 heading', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'missing-h1',
            severity: 'major' as const,
            description: 'Document has no H1 heading',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const h1Issue = result.issues.find(i => i.code === 'MATTERHORN-06-001');
      expect(h1Issue).toBeDefined();
      expect(h1Issue?.severity).toBe('serious');
      expect(h1Issue?.wcagCriteria).toContain('1.3.1');
      expect(h1Issue?.wcagCriteria).toContain('2.4.6');
    });

    it('should identify skipped heading levels', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'skipped-level',
            severity: 'major' as const,
            description: 'Heading level skipped from H1 to H3',
            location: 'Page 2',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const skipIssue = result.issues.find(i => i.code === 'HEADING-SKIP');
      expect(skipIssue).toBeDefined();
      expect(skipIssue?.severity).toBe('serious');
      expect(skipIssue?.suggestion).toContain('not skipping levels');
    });

    it('should identify multiple H1 headings as moderate issue', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'multiple-h1',
            severity: 'minor' as const,
            description: 'Document has 3 H1 headings',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const multiH1Issue = result.issues.find(i => i.code === 'HEADING-MULTIPLE-H1');
      expect(multiH1Issue).toBeDefined();
      expect(multiH1Issue?.severity).toBe('moderate');
    });
  });

  describe('reading order validation', () => {
    it('should identify illogical reading order', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: false,
        readingOrderIssues: [
          {
            type: 'column-confusion',
            description: 'Multi-column layout detected without proper tagging',
            pageNumber: 3,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const readingOrderIssue = result.issues.find(i => i.code === 'MATTERHORN-09-004');
      expect(readingOrderIssue).toBeDefined();
      expect(readingOrderIssue?.severity).toBe('serious');
      expect(readingOrderIssue?.wcagCriteria).toContain('1.3.2');

      const columnIssue = result.issues.find(i => i.code === 'READING-ORDER-COLUMNS');
      expect(columnIssue).toBeDefined();
      expect(columnIssue?.location).toContain('Page 3');
    });
  });

  describe('table validation', () => {
    it('should identify table without headers', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        tables: [
          {
            id: 'table_p1_0',
            pageNumber: 1,
            position: { x: 50, y: 100, width: 500, height: 200 },
            rowCount: 5,
            columnCount: 3,
            hasHeaderRow: false,
            hasHeaderColumn: false,
            hasSummary: false,
            cells: [],
            issues: ['Table has no header cells (TH). Add row or column headers.'],
            isAccessible: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const tableIssue = result.issues.find(i => i.code === 'TABLE-INACCESSIBLE');
      expect(tableIssue).toBeDefined();
      expect(tableIssue?.severity).toBe('serious');
      expect(tableIssue?.message).toContain('missing header cells');
      expect(tableIssue?.location).toContain('Page 1');
    });

    it('should identify complex table without summary', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        tables: [
          {
            id: 'table_p2_0',
            pageNumber: 2,
            position: { x: 50, y: 100, width: 500, height: 300 },
            rowCount: 10,
            columnCount: 5,
            hasHeaderRow: true,
            hasHeaderColumn: false,
            hasSummary: false,
            cells: [],
            issues: ['Complex table should have a summary describing its structure.'],
            isAccessible: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const tableIssue = result.issues.find(i => i.message.includes('complex table without summary'));
      expect(tableIssue).toBeDefined();
      expect(tableIssue?.severity).toBe('serious');
    });
  });

  describe('list validation', () => {
    it('should identify lists in untagged PDF', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        lists: [
          {
            id: 'list_p1_0',
            pageNumber: 1,
            type: 'unordered',
            itemCount: 5,
            items: [],
            position: { x: 50, y: 100 },
            isProperlyTagged: false,
          },
          {
            id: 'list_p2_0',
            pageNumber: 2,
            type: 'ordered',
            itemCount: 3,
            items: [],
            position: { x: 50, y: 150 },
            isProperlyTagged: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const listIssue = result.issues.find(i => i.code === 'LIST-NOT-TAGGED');
      expect(listIssue).toBeDefined();
      expect(listIssue?.severity).toBe('moderate');
      expect(listIssue?.message).toContain('2 list(s)');
    });

    it('should identify improperly tagged lists', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        lists: [
          {
            id: 'list_p1_0',
            pageNumber: 1,
            type: 'unordered',
            itemCount: 5,
            items: [],
            position: { x: 50, y: 100 },
            isProperlyTagged: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const listIssue = result.issues.find(i => i.code === 'LIST-IMPROPER-MARKUP');
      expect(listIssue).toBeDefined();
      expect(listIssue?.severity).toBe('moderate');
      expect(listIssue?.location).toContain('Page 1');
      expect(listIssue?.suggestion).toContain('L (list), LI (list item)');
    });
  });

  describe('summary calculation', () => {
    it('should correctly calculate issue summary', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: false,
        hasTitle: false,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: false,
        hasLogicalReadingOrder: false,
        headingIssues: [
          {
            type: 'missing-h1',
            severity: 'major' as const,
            description: 'Document has no H1 heading',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.summary.total).toBe(result.issues.length);
      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.summary.critical + result.summary.serious + result.summary.moderate + result.summary.minor)
        .toBe(result.summary.total);
    });
  });
});

// Helper functions to create mock data

function createMockParsedPdf(options: {
  isTagged: boolean;
  hasLanguage: boolean;
  hasTitle: boolean;
}): ParsedPDF {
  return {
    structure: {
      pageCount: 10,
      metadata: {
        isTagged: options.isTagged,
        language: options.hasLanguage ? 'en' : undefined,
        title: options.hasTitle ? 'Test Document' : undefined,
        suspect: false,
        hasAcroForm: false,
      },
      outline: [],
    },
    pdfLibDoc: {} as any,
    pdfjsDoc: {} as any,
  } as ParsedPDF;
}

function createMockStructure(options: {
  isTaggedPDF: boolean;
  hasProperHeadingHierarchy: boolean;
  hasDocumentLanguage: boolean;
  hasLogicalReadingOrder: boolean;
  headingIssues?: Array<{
    type: 'missing-h1' | 'multiple-h1' | 'skipped-level' | 'improper-nesting';
    severity: 'critical' | 'major' | 'minor';
    description: string;
    location: string;
    wcagCriterion: string;
  }>;
  readingOrderIssues?: Array<{
    type: 'visual-order' | 'column-confusion' | 'float-interruption' | 'table-reading';
    description: string;
    pageNumber: number;
    location?: string;
  }>;
  tables?: Array<{
    id: string;
    pageNumber: number;
    position: { x: number; y: number; width: number; height: number };
    rowCount: number;
    columnCount: number;
    hasHeaderRow: boolean;
    hasHeaderColumn: boolean;
    hasSummary: boolean;
    cells: any[];
    issues: string[];
    isAccessible: boolean;
  }>;
  lists?: Array<{
    id: string;
    pageNumber: number;
    type: 'ordered' | 'unordered' | 'definition';
    itemCount: number;
    items: any[];
    position: { x: number; y: number };
    isProperlyTagged: boolean;
  }>;
}): DocumentStructure {
  return {
    isTaggedPDF: options.isTaggedPDF,
    headings: {
      headings: [],
      hasProperHierarchy: options.hasProperHeadingHierarchy,
      hasH1: true,
      multipleH1: false,
      skippedLevels: [],
      issues: options.headingIssues || [],
    },
    tables: options.tables || [],
    lists: options.lists || [],
    links: [],
    readingOrder: {
      isLogical: options.hasLogicalReadingOrder,
      hasStructureTree: options.isTaggedPDF,
      issues: options.readingOrderIssues || [],
      confidence: options.hasLogicalReadingOrder ? 0.9 : 0.5,
    },
    language: {
      documentLanguage: options.hasDocumentLanguage ? 'en' : undefined,
      hasDocumentLanguage: options.hasDocumentLanguage,
      languageChanges: [],
      issues: [],
    },
    bookmarks: [],
    formFields: [],
    accessibilityScore: 85,
    summary: {
      totalHeadings: 0,
      totalTables: options.tables?.length || 0,
      totalLists: options.lists?.length || 0,
      totalLinks: 0,
      totalImages: 0,
      totalFormFields: 0,
      criticalIssues: 0,
      majorIssues: 0,
      minorIssues: 0,
    },
  };
}
