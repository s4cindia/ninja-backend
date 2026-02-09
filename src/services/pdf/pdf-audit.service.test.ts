import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pdfAuditService } from './pdf-audit.service';
import { pdfComprehensiveParserService, PdfParseResult } from './pdf-comprehensive-parser.service';

// Mock dependencies
vi.mock('./pdf-comprehensive-parser.service');

describe('PdfAuditService', () => {
  const mockParsedPdf: PdfParseResult = {
    metadata: {
      title: 'Test PDF',
      author: 'Test Author',
      pdfVersion: '1.7',
      isEncrypted: false,
      isLinearized: false,
      isTagged: true,
      hasOutline: false,
      hasAcroForm: false,
      hasXFA: false,
      pageCount: 2,
      hasStructureTree: true,
      language: 'en-US',
    },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        rotation: 0,
        content: [
          {
            text: 'Hello World',
            position: { x: 100, y: 100, width: 100, height: 20 },
            font: { name: 'Arial', size: 12 },
          },
        ],
        images: [
          {
            id: 'img-1',
            position: { x: 50, y: 50, width: 100, height: 100 },
            hasAltText: true,
            altText: 'Test image',
          },
        ],
        links: [],
        formFields: [],
        headings: [],
        tables: [],
        lists: [],
      },
      {
        pageNumber: 2,
        width: 612,
        height: 792,
        rotation: 0,
        content: [],
        images: [],
        links: [],
        formFields: [],
        headings: [],
        tables: [],
        lists: [],
      },
    ],
    isTagged: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runAudit', () => {
    it('should successfully complete audit workflow', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result).toBeDefined();
      expect(result.jobId).toBe('job-123');
      expect(result.fileName).toBe('test.pdf');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.issues).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.wcagMappings).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it('should parse PDF using comprehensive parser', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(pdfComprehensiveParserService.parse).toHaveBeenCalledWith('/test/file.pdf');
    });

    it('should detect untagged PDF', async () => {
      const untaggedPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          hasStructureTree: false,
        },
        isTagged: false,
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(untaggedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const untaggedIssue = result.issues.find(i => i.code === 'PDF-UNTAGGED');
      expect(untaggedIssue).toBeDefined();
      expect(untaggedIssue?.severity).toBe('critical');
      expect(untaggedIssue?.wcagCriteria).toContain('1.3.1');
      expect(untaggedIssue?.wcagCriteria).toContain('4.1.2');
    });

    it('should detect missing document language', async () => {
      const noLangPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          language: undefined,
        },
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(noLangPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const langIssue = result.issues.find(i => i.code === 'PDF-NO-LANGUAGE');
      expect(langIssue).toBeDefined();
      expect(langIssue?.severity).toBe('serious');
      expect(langIssue?.wcagCriteria).toContain('3.1.1');
    });

    it('should detect missing document title', async () => {
      const noTitlePdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          title: undefined,
        },
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(noTitlePdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const titleIssue = result.issues.find(i => i.code === 'PDF-NO-TITLE');
      expect(titleIssue).toBeDefined();
      expect(titleIssue?.severity).toBe('serious');
      expect(titleIssue?.wcagCriteria).toContain('2.4.2');
    });

    it('should detect images without alt text', async () => {
      const noAltPdf: PdfParseResult = {
        ...mockParsedPdf,
        pages: [
          {
            ...mockParsedPdf.pages[0],
            images: [
              {
                id: 'img-1',
                position: { x: 50, y: 50, width: 100, height: 100 },
                hasAltText: false,
              },
            ],
          },
          mockParsedPdf.pages[1],
        ],
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(noAltPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const altIssue = result.issues.find(i => i.code === 'PDF-IMAGE-NO-ALT');
      expect(altIssue).toBeDefined();
      expect(altIssue?.severity).toBe('critical');
      expect(altIssue?.wcagCriteria).toContain('1.1.1');
      expect(altIssue?.location).toContain('Page 1');
    });

    it('should detect inaccessible tables', async () => {
      const tablePdf: PdfParseResult = {
        ...mockParsedPdf,
        pages: [
          {
            ...mockParsedPdf.pages[0],
            tables: [
              {
                id: 'table-1',
                pageNumber: 1,
                position: { x: 100, y: 100, width: 400, height: 200 },
                rowCount: 3,
                columnCount: 3,
                hasHeaderRow: false,
                hasHeaderColumn: false,
                hasSummary: false,
                cells: [],
                issues: ['Missing table headers'],
                isAccessible: false,
              },
            ],
          },
          mockParsedPdf.pages[1],
        ],
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(tablePdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const tableIssue = result.issues.find(i => i.code === 'PDF-TABLE-INACCESSIBLE');
      expect(tableIssue).toBeDefined();
      expect(tableIssue?.severity).toBe('serious');
      expect(tableIssue?.wcagCriteria).toContain('1.3.1');
      expect(tableIssue?.suggestion).toContain('Missing table headers');
    });
  });

  describe('validation', () => {
    it('should run all validators', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      // Validators should have run (check metadata)
      expect(result.metadata).toBeDefined();
      expect(result.metadata.categorizedIssues).toBeDefined();
    });

    it('should categorize issues by validator', async () => {
      const problemPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          hasStructureTree: false,
          language: undefined,
          title: undefined,
        },
        isTagged: false,
        pages: [
          {
            ...mockParsedPdf.pages[0],
            images: [
              {
                id: 'img-1',
                position: { x: 50, y: 50, width: 100, height: 100 },
                hasAltText: false,
              },
            ],
            tables: [
              {
                id: 'table-1',
                pageNumber: 1,
                position: { x: 100, y: 100, width: 400, height: 200 },
                rowCount: 2,
                columnCount: 2,
                hasHeaderRow: false,
                hasHeaderColumn: false,
                hasSummary: false,
                cells: [],
                issues: ['Missing headers'],
                isAccessible: false,
              },
            ],
          },
          mockParsedPdf.pages[1],
        ],
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(problemPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const metadata = result.metadata as Record<string, unknown>;
      const categorizedIssues = metadata.categorizedIssues as Record<string, number>;
      expect(categorizedIssues.structure).toBeGreaterThan(0);
      expect(categorizedIssues.altText).toBeGreaterThan(0);
      expect(categorizedIssues.table).toBeGreaterThan(0);
    });

    it('should deduplicate issues', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      // Check that issues don't have duplicates
      const issueKeys = result.issues.map(i =>
        JSON.stringify([i.source, i.code, i.location || '', i.message])
      );
      const uniqueKeys = new Set(issueKeys);
      expect(issueKeys.length).toBe(uniqueKeys.size);
    });
  });

  describe('scoring', () => {
    it('should calculate score based on issue severity', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result.scoreBreakdown).toBeDefined();
      expect(result.scoreBreakdown.score).toBe(result.score);
      expect(result.scoreBreakdown.formula).toBe(
        '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)'
      );
    });

    it('should have perfect score for fully accessible PDF', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result.score).toBe(100);
      expect(result.issues).toHaveLength(0);
    });

    it('should deduct points for issues', async () => {
      const problemPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          hasStructureTree: false,
        },
        isTagged: false,
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(problemPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result.score).toBeLessThan(100);
      expect(result.scoreBreakdown.totalDeduction).toBeGreaterThan(0);
    });
  });

  describe('WCAG mapping', () => {
    it('should map issues to WCAG criteria', async () => {
      const problemPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          hasStructureTree: false,
        },
        isTagged: false,
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(problemPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result.wcagMappings).toBeDefined();
      expect(result.wcagMappings.length).toBeGreaterThan(0);

      const mapping = result.wcagMappings[0];
      expect(mapping.criteria).toBeDefined();
      expect(mapping.level).toMatch(/^(A|AA|AAA)$/);
      expect(mapping.principle).toMatch(/^(Perceivable|Operable|Understandable|Robust)$/);
    });
  });

  describe('Matterhorn Protocol', () => {
    it('should generate Matterhorn checkpoint results', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const metadata = result.metadata as Record<string, unknown>;
      expect(metadata.matterhornCheckpoints).toBeGreaterThan(0);
      expect(metadata.matterhornPassed).toBeDefined();
      expect(metadata.matterhornFailed).toBeDefined();
    });

    it('should map Matterhorn checkpoint 01 (Tagged PDF)', async () => {
      const untaggedPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          hasStructureTree: false,
        },
        isTagged: false,
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(untaggedPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const metadata = result.metadata as Record<string, unknown>;
      expect(metadata.matterhornFailed).toBeGreaterThan(0);
    });

    it('should map Matterhorn checkpoint 07 (Document title)', async () => {
      const noTitlePdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          title: undefined,
        },
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(noTitlePdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const metadata = result.metadata as Record<string, unknown>;
      expect(metadata.matterhornFailed).toBeGreaterThan(0);
    });

    it('should map Matterhorn checkpoint 16 (Natural language)', async () => {
      const noLangPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          language: undefined,
        },
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(noLangPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      const metadata = result.metadata as Record<string, unknown>;
      expect(metadata.matterhornFailed).toBeGreaterThan(0);
    });
  });

  describe('summary', () => {
    it('should provide issue summary by severity', async () => {
      const problemPdf: PdfParseResult = {
        ...mockParsedPdf,
        metadata: {
          ...mockParsedPdf.metadata,
          isTagged: false,
          title: undefined,
          language: undefined,
        },
        isTagged: false,
        pages: [
          {
            ...mockParsedPdf.pages[0],
            images: [
              {
                id: 'img-1',
                position: { x: 50, y: 50, width: 100, height: 100 },
                hasAltText: false,
              },
            ],
          },
          mockParsedPdf.pages[1],
        ],
      };

      vi.mocked(pdfComprehensiveParserService.parse).mockResolvedValue(problemPdf);

      const result = await pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result.summary).toBeDefined();
      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.summary.critical).toBeGreaterThanOrEqual(0);
      expect(result.summary.serious).toBeGreaterThanOrEqual(0);
      expect(result.summary.moderate).toBeGreaterThanOrEqual(0);
      expect(result.summary.minor).toBeGreaterThanOrEqual(0);
      expect(result.summary.total).toBe(
        result.summary.critical +
        result.summary.serious +
        result.summary.moderate +
        result.summary.minor
      );
    });
  });

  describe('runAuditFromBuffer', () => {
    it('should audit PDF from buffer', async () => {
      const buffer = Buffer.from('fake pdf content');

      vi.mocked(pdfComprehensiveParserService.parseBuffer).mockResolvedValue(mockParsedPdf);

      const result = await pdfAuditService.runAuditFromBuffer(buffer, 'job-123', 'test.pdf');

      expect(result).toBeDefined();
      expect(result.jobId).toBe('job-123');
      expect(result.fileName).toBe('test.pdf');
      expect(pdfComprehensiveParserService.parseBuffer).toHaveBeenCalledWith(buffer, 'test.pdf');
    });

    it('should handle buffer parse errors', async () => {
      const buffer = Buffer.from('invalid pdf');

      vi.mocked(pdfComprehensiveParserService.parseBuffer).mockRejectedValue(
        new Error('Invalid PDF')
      );

      await expect(
        pdfAuditService.runAuditFromBuffer(buffer, 'job-123', 'test.pdf')
      ).rejects.toThrow('Invalid PDF');
    });
  });

  describe('error handling', () => {
    it('should propagate parse errors', async () => {
      vi.mocked(pdfComprehensiveParserService.parse).mockRejectedValue(
        new Error('Parse failed')
      );

      await expect(
        pdfAuditService.runAudit('/test/file.pdf', 'job-123', 'test.pdf')
      ).rejects.toThrow('Parse failed');
    });
  });
});
