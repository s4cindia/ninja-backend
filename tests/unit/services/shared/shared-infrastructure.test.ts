import { describe, it, expect, beforeEach } from 'vitest';
import {
  EditorialAiClient,
  DocumentParser,
  ReportGenerator,
  documentParser,
  reportGenerator,
  ValidationIssue,
  ReportConfig,
} from '../../../../src/services/shared';

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

    it('should parse plain text successfully', async () => {
      const text = 'This is a test document. It has multiple sentences.';
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

      expect(result.format).toBe('json');
      expect(result.filename).toContain('test-document');
      expect(result.content).toBeDefined();
    });

    it('should throw for PDF format (not implemented)', async () => {
      const config: ReportConfig = {
        title: 'Test',
        documentName: 'test.docx',
        generatedAt: new Date(),
        analyzedBy: 'Test',
        includeOriginalText: false,
        includeSuggestions: false,
        groupByType: false,
      };

      await expect(generator.generate([], config, 'pdf')).rejects.toThrow();
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
