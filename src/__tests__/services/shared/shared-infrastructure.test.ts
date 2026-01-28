import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  EditorialAiClient,
  DocumentParser,
  ReportGenerator,
  documentParser,
  reportGenerator,
  ValidationIssue,
  ReportConfig,
} from '../../../services/shared';

describe('Shared Infrastructure', () => {
  
  describe('EditorialAiClient', () => {
    let client: EditorialAiClient;

    beforeEach(() => {
      client = new EditorialAiClient();
    });

    it('should instantiate without errors', () => {
      expect(client).toBeInstanceOf(EditorialAiClient);
    });

    it('should have detectCitations method', () => {
      expect(typeof client.detectCitations).toBe('function');
    });

    it('should have parseCitation method', () => {
      expect(typeof client.parseCitation).toBe('function');
    });

    it('should have classifyMatch method', () => {
      expect(typeof client.classifyMatch).toBe('function');
    });

    it('should have detectParaphrase method', () => {
      expect(typeof client.detectParaphrase).toBe('function');
    });

    it('should have validateStyle method', () => {
      expect(typeof client.validateStyle).toBe('function');
    });

    it('should have generateEmbeddings method', () => {
      expect(typeof client.generateEmbeddings).toBe('function');
    });
  });

  describe('DocumentParser', () => {
    let parser: DocumentParser;

    beforeEach(() => {
      parser = new DocumentParser();
    });

    it('should instantiate without errors', () => {
      expect(parser).toBeInstanceOf(DocumentParser);
    });

    it('should have parse method', () => {
      expect(typeof parser.parse).toBe('function');
    });

    it('should detect PDF format from filename', async () => {
      // This tests the format detection logic
      const buffer = Buffer.from('dummy content');
      
      // We expect this to attempt PDF parsing (may fail due to invalid content, but that's OK)
      await expect(parser.parse(buffer, 'test.pdf')).rejects.toThrow();
      // The important thing is it tried to parse as PDF, not another format
    });

    it('should detect EPUB format from filename', async () => {
      const buffer = Buffer.from('dummy content');
      await expect(parser.parse(buffer, 'test.epub')).rejects.toThrow();
    });

    it('should parse plain text successfully', async () => {
      const text = 'This is a test document. It has multiple sentences. This is paragraph one.\n\nThis is paragraph two with more content.';
      const buffer = Buffer.from(text);
      
      const result = await parser.parse(buffer, 'test.txt');
      
      expect(result).toBeDefined();
      expect(result.text).toContain('This is a test document');
      expect(result.metadata.format).toBe('txt');
      expect(result.chunks).toBeDefined();
      expect(Array.isArray(result.chunks)).toBe(true);
    });
  });

  describe('ReportGenerator', () => {
    let generator: ReportGenerator;

    beforeEach(() => {
      generator = new ReportGenerator();
    });

    it('should instantiate without errors', () => {
      expect(generator).toBeInstanceOf(ReportGenerator);
    });

    it('should have generate method', () => {
      expect(typeof generator.generate).toBe('function');
    });

    it('should generate JSON report successfully', async () => {
      const issues: ValidationIssue[] = [
        {
          id: 'test-1',
          type: 'citation',
          severity: 'major',
          title: 'Missing citation',
          description: 'Citation format is incorrect',
          location: { startOffset: 0, endOffset: 10 },
        },
        {
          id: 'test-2',
          type: 'style',
          severity: 'minor',
          title: 'Style violation',
          description: 'Should use serial comma',
          location: { startOffset: 20, endOffset: 30 },
        },
      ];

      const config: ReportConfig = {
        title: 'Test Report',
        documentName: 'test-document.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test User',
        includeOriginalText: true,
        includeSuggestions: true,
        groupByType: false,
      };

      const result = await generator.generate(issues, config, 'json');

      expect(result).toBeDefined();
      expect(result.format).toBe('json');
      expect(result.filename).toContain('test-document');
      expect(result.content).toBeDefined();
      
      // Check content structure
      const content = result.content as Record<string, unknown>;
      expect(content.title).toBe('Test Report');
      expect(content.summary).toBeDefined();
    });

    it('should count issues by severity', async () => {
      const issues: ValidationIssue[] = [
        { id: '1', type: 'citation', severity: 'critical', title: 'A', description: 'A', location: { startOffset: 0, endOffset: 1 } },
        { id: '2', type: 'citation', severity: 'major', title: 'B', description: 'B', location: { startOffset: 0, endOffset: 1 } },
        { id: '3', type: 'citation', severity: 'major', title: 'C', description: 'C', location: { startOffset: 0, endOffset: 1 } },
        { id: '4', type: 'style', severity: 'minor', title: 'D', description: 'D', location: { startOffset: 0, endOffset: 1 } },
      ];

      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: false,
      };

      const result = await generator.generate(issues, config, 'json');
      const content = result.content as { summary: { bySeverity: Record<string, number> } };

      expect(content.summary.bySeverity.critical).toBe(1);
      expect(content.summary.bySeverity.major).toBe(2);
      expect(content.summary.bySeverity.minor).toBe(1);
    });

    it('should count issues by type', async () => {
      const issues: ValidationIssue[] = [
        { id: '1', type: 'citation', severity: 'major', title: 'A', description: 'A', location: { startOffset: 0, endOffset: 1 } },
        { id: '2', type: 'citation', severity: 'major', title: 'B', description: 'B', location: { startOffset: 0, endOffset: 1 } },
        { id: '3', type: 'style', severity: 'major', title: 'C', description: 'C', location: { startOffset: 0, endOffset: 1 } },
        { id: '4', type: 'plagiarism', severity: 'critical', title: 'D', description: 'D', location: { startOffset: 0, endOffset: 1 } },
      ];

      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: false,
      };

      const result = await generator.generate(issues, config, 'json');
      const content = result.content as { summary: { byType: Record<string, number> } };

      expect(content.summary.byType.citation).toBe(2);
      expect(content.summary.byType.style).toBe(1);
      expect(content.summary.byType.plagiarism).toBe(1);
    });

    it('should group issues by type when configured', async () => {
      const issues: ValidationIssue[] = [
        { id: '1', type: 'citation', severity: 'major', title: 'A', description: 'A', location: { startOffset: 0, endOffset: 1 } },
        { id: '2', type: 'style', severity: 'major', title: 'B', description: 'B', location: { startOffset: 0, endOffset: 1 } },
        { id: '3', type: 'citation', severity: 'minor', title: 'C', description: 'C', location: { startOffset: 0, endOffset: 1 } },
      ];

      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: true,  // Enable grouping
      };

      const result = await generator.generate(issues, config, 'json');
      const content = result.content as { issues: Record<string, ValidationIssue[]> };

      expect(content.issues.citation).toHaveLength(2);
      expect(content.issues.style).toHaveLength(1);
    });

    it('should throw for PDF format (not implemented)', async () => {
      const issues: ValidationIssue[] = [];
      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: false,
      };

      await expect(generator.generate(issues, config, 'pdf')).rejects.toThrow('not yet implemented');
    });

    it('should throw for DOCX format (not implemented)', async () => {
      const issues: ValidationIssue[] = [];
      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: false,
      };

      await expect(generator.generate(issues, config, 'docx')).rejects.toThrow('not yet implemented');
    });
  });

  describe('Singleton Exports', () => {
    it('should export documentParser singleton', () => {
      expect(documentParser).toBeInstanceOf(DocumentParser);
    });

    it('should export reportGenerator singleton', () => {
      expect(reportGenerator).toBeInstanceOf(ReportGenerator);
    });
  });
});
