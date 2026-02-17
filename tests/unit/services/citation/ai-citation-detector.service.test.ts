/**
 * AI Citation Detector Service Tests
 *
 * Tests for AI-powered citation detection and reference extraction
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock Claude service - mock all methods including generateJSONWithUsage
vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
    generateJSON: vi.fn(),
    generateJSONWithUsage: vi.fn().mockImplementation(async () => ({
      data: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
    })),
    generate: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { claudeService } from '../../../../src/services/ai/claude.service';
import { aiCitationDetectorService } from '../../../../src/services/citation/ai-citation-detector.service';

describe('AICitationDetectorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mocks to clean state
    vi.mocked(claudeService.generate).mockReset();
    vi.mocked(claudeService.generateJSONWithUsage).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('analyzeDocument', () => {
    it('should detect numeric citations correctly', async () => {
      const documentText = `
        This study found significant results [1].
        Previous research [2] supports this.
        Multiple citations [3, 4] are common.
      `;

      const mockCitations = [
        { id: 'c1', text: '[1]', position: { paragraph: 1, sentence: 1, startChar: 35, endChar: 38 }, type: 'numeric', format: 'bracket', numbers: [1], context: 'results [1].' },
        { id: 'c2', text: '[2]', position: { paragraph: 2, sentence: 1, startChar: 20, endChar: 23 }, type: 'numeric', format: 'bracket', numbers: [2], context: 'research [2] supports' },
        { id: 'c3', text: '[3, 4]', position: { paragraph: 3, sentence: 1, startChar: 20, endChar: 26 }, type: 'numeric', format: 'bracket', numbers: [3, 4], context: 'citations [3, 4] are' },
      ];

      // Mock references use flat structure (as AI returns), service wraps into 'components'
      const mockReferences = [
        { number: 1, rawText: 'Smith J. Paper title. Journal. 2023;1:1-10.', authors: ['Smith J'], year: '2023', title: 'Paper title' },
        { number: 2, rawText: 'Jones A. Another paper. Journal. 2022;2:20-30.', authors: ['Jones A'], year: '2022', title: 'Another paper' },
      ];

      // Mock generate for style detection - called 3rd
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver', usage: { input_tokens: 10, output_tokens: 5 } } as any);

      // generateJSON is called twice: once for citations, once for references
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: mockCitations, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(3);
      expect(result.references).toHaveLength(2);
      expect(result.detectedStyle).toBeDefined();
    });

    it('should detect author-year citations correctly', async () => {
      const documentText = `
        According to Smith (2023), this is true.
        Jones et al. (2022) also confirmed this finding.
        (Brown & White, 2021) provides additional evidence.
      `;

      const mockCitations = [
        { id: 'c1', text: 'Smith (2023)', position: { paragraph: 1, sentence: 1, startChar: 13, endChar: 25 }, type: 'author-year', format: 'parenthesis', numbers: [], context: 'According to Smith (2023)' },
        { id: 'c2', text: 'Jones et al. (2022)', position: { paragraph: 2, sentence: 1, startChar: 8, endChar: 27 }, type: 'author-year', format: 'parenthesis', numbers: [], context: 'Jones et al. (2022) also' },
        { id: 'c3', text: '(Brown & White, 2021)', position: { paragraph: 3, sentence: 1, startChar: 8, endChar: 29 }, type: 'author-year', format: 'parenthesis', numbers: [], context: '(Brown & White, 2021) provides' },
      ];

      // Mock references use flat structure (as AI returns)
      const mockReferences = [
        { number: 1, rawText: 'Smith, J. (2023). Paper title. Journal, 1, 1-10.', authors: ['Smith, J.'], year: '2023', title: 'Paper title' },
      ];

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'APA', usage: { input_tokens: 10, output_tokens: 5 } } as any);

      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: mockCitations, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(3);
      expect(result.inTextCitations[0].type).toBe('author-year');
    });

    it('should handle documents with no citations', async () => {
      const documentText = 'This is a simple document without any citations or references.';

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' });

      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
    });

    it('should handle AI service errors gracefully', async () => {
      const documentText = 'Document with citations [1].';

      // Mock generateJSONWithUsage to throw error - inner methods catch and return []
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockRejectedValueOnce(new Error('AI service unavailable'))
        .mockRejectedValueOnce(new Error('AI service unavailable'));
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' } as any);

      // Service gracefully handles errors - returns empty results
      const result = await aiCitationDetectorService.analyzeDocument(documentText);
      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
      expect(result.detectedStyle).toBe('Unknown');
    });

    it('should handle malformed AI responses for citations', async () => {
      const documentText = 'Document [1].';

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' } as any);

      // Return non-array response wrapped in data
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: { invalid: 'response' }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
        .mockResolvedValueOnce({ data: null, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
    });

    it('should extract reference components correctly', async () => {
      const documentText = 'Citation [1].';

      const mockCitations = [
        { id: 'c1', text: '[1]', position: { paragraph: 1, sentence: 1, startChar: 9, endChar: 12 }, type: 'numeric', format: 'bracket', numbers: [1], context: 'Citation [1].' }
      ];

      // Mock references must match the flat structure the AI returns
      // The service wraps these fields into a 'components' object
      const mockReferences = [
        {
          number: 1,
          rawText: 'Smith J, Jones A. Article Title. Nature. 2023;580(7801):100-105. doi:10.1038/s41586-023-00001-0',
          authors: ['Smith J', 'Jones A'],
          year: '2023',
          title: 'Article Title',
          journal: 'Nature',
          volume: '580',
          issue: '7801',
          pages: '100-105',
          doi: '10.1038/s41586-023-00001-0',
        },
      ];

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' } as any);

      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: mockCitations, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.references).toHaveLength(1);
      expect(result.references[0].components?.authors).toContain('Smith J');
      expect(result.references[0].components?.doi).toBe('10.1038/s41586-023-00001-0');
    });

    it('should return statistics about citations and references', async () => {
      const documentText = 'Document with [1] and [2].';

      const mockCitations = [
        { id: 'c1', text: '[1]', position: { paragraph: 1, sentence: 1, startChar: 10, endChar: 13 }, type: 'numeric', format: 'bracket', numbers: [1], context: 'with [1] and' },
        { id: 'c2', text: '[2]', position: { paragraph: 1, sentence: 1, startChar: 20, endChar: 23 }, type: 'numeric', format: 'bracket', numbers: [2], context: 'and [2].' },
      ];

      // Mock references use flat structure (as AI returns)
      const mockReferences = [
        { number: 1, rawText: 'Ref 1', authors: ['A'], year: '2020' },
        { number: 2, rawText: 'Ref 2', authors: ['B'], year: '2021' },
      ];

      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' } as any);
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: mockCitations, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.statistics).toBeDefined();
      expect(result.statistics.totalCitations).toBe(2);
      expect(result.statistics.totalReferences).toBe(2);
    });

    it('should track token usage in result', async () => {
      const documentText = 'Document with [1] citation.';

      const mockCitations = [
        { id: 'c1', text: '[1]', position: { paragraph: 1, sentence: 1, startChar: 10, endChar: 13 }, type: 'numeric', format: 'bracket', numbers: [1], context: 'with [1]' }
      ];
      // Mock references use flat structure (as AI returns)
      const mockReferences = [
        { number: 1, rawText: 'Ref 1', authors: ['A'], year: '2023' }
      ];

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' } as any);

      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: mockCitations, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result).toBeDefined();
      expect(result.inTextCitations).toHaveLength(1);
      // Token usage is tracked in the result
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.totalTokens).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Citation Style Detection', () => {
    it('should detect APA style when references are present', async () => {
      const documentText = 'According to Smith (2023), the results were significant (Jones & Brown, 2022).';

      // Mock references use flat structure (as AI returns)
      const mockReferences = [
        { number: 1, rawText: 'Smith, J. (2023). Paper title. Journal, 1(1), 1-10.', authors: ['Smith, J.'], year: '2023', title: 'Paper title' }
      ];

      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'APA' } as any);
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.detectedStyle).toBe('APA');
    });

    it('should detect Vancouver/numeric style when references are present', async () => {
      const documentText = 'Results were confirmed [1]. Further analysis [2,3] supported this.';

      // Mock references use flat structure (as AI returns)
      const mockReferences = [
        { number: 1, rawText: '1. Smith J. Paper title. J Med. 2023;1:1-10.', authors: ['Smith J'], year: '2023', title: 'Paper title' }
      ];

      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' } as any);
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
        .mockResolvedValueOnce({ data: mockReferences, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.detectedStyle).toBe('Vancouver');
    });

    it('should return Unknown for unrecognized styles', async () => {
      const documentText = 'Plain text without clear citation format.';

      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' } as any);
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })
        .mockResolvedValueOnce({ data: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.detectedStyle).toBe('Unknown');
    });
  });

  describe('Error Handling', () => {
    it('should handle rate limit errors gracefully', async () => {
      const documentText = 'Document [1].';

      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).status = 429;

      // Both inner methods will fail
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError);
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' } as any);

      // Service gracefully handles errors - returns empty results
      const result = await aiCitationDetectorService.analyzeDocument(documentText);
      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
    });

    it('should handle network timeout errors gracefully', async () => {
      const documentText = 'Document [1].';

      const timeoutError = new Error('ETIMEDOUT');
      // Both inner methods will fail
      vi.mocked(claudeService.generateJSONWithUsage)
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError);
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' } as any);

      // Service gracefully handles errors - returns empty results
      const result = await aiCitationDetectorService.analyzeDocument(documentText);
      expect(result.inTextCitations).toHaveLength(0);
      expect(result.detectedStyle).toBe('Unknown');
    });
  });
});
