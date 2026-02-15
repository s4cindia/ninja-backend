/**
 * AI Citation Detector Service Tests
 *
 * Tests for AI-powered citation detection and reference extraction
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock Claude service - mock both generate and generateJSON
vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
    generateJSON: vi.fn(),
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
    vi.mocked(claudeService.generateJSON).mockReset();
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
        { text: '[1]', paragraph: 1, startChar: 35, type: 'numeric', format: 'bracket', confidence: 0.95 },
        { text: '[2]', paragraph: 2, startChar: 20, type: 'numeric', format: 'bracket', confidence: 0.95 },
        { text: '[3, 4]', paragraph: 3, startChar: 20, type: 'numeric', format: 'bracket', confidence: 0.90 },
      ];

      const mockReferences = [
        { number: 1, rawText: 'Smith J. Paper title. Journal. 2023;1:1-10.', authors: ['Smith J'], year: '2023', title: 'Paper title' },
        { number: 2, rawText: 'Jones A. Another paper. Journal. 2022;2:20-30.', authors: ['Jones A'], year: '2022', title: 'Another paper' },
      ];

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' });

      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce(mockCitations)
        .mockResolvedValueOnce(mockReferences);

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
        { text: 'Smith (2023)', paragraph: 1, startChar: 13, type: 'author-year', format: 'parenthesis', confidence: 0.90 },
        { text: 'Jones et al. (2022)', paragraph: 2, startChar: 8, type: 'author-year', format: 'parenthesis', confidence: 0.90 },
        { text: '(Brown & White, 2021)', paragraph: 3, startChar: 8, type: 'author-year', format: 'parenthesis', confidence: 0.85 },
      ];

      const mockReferences = [
        { rawText: 'Smith, J. (2023). Paper title. Journal, 1, 1-10.', authors: ['Smith, J.'], year: '2023' },
      ];

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'APA' });

      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce(mockCitations)
        .mockResolvedValueOnce(mockReferences);

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(3);
      expect(result.inTextCitations[0].type).toBe('author-year');
    });

    it('should handle documents with no citations', async () => {
      const documentText = 'This is a simple document without any citations or references.';

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' });

      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
    });

    it('should handle AI service errors gracefully', async () => {
      const documentText = 'Document with citations [1].';

      // Mock generateJSON to throw error (this is called before generate)
      vi.mocked(claudeService.generateJSON).mockRejectedValueOnce(new Error('AI service unavailable'));
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' });

      // Service catches errors and returns empty results
      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      // Should return empty arrays on error (graceful degradation)
      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
      expect(result.detectedStyle).toBe('Unknown');
    });

    it('should handle malformed AI responses for citations', async () => {
      const documentText = 'Document [1].';

      // Mock generate for style detection
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Unknown' });

      // Return non-array response
      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce({ invalid: 'response' })
        .mockResolvedValueOnce(null);

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.inTextCitations).toHaveLength(0);
      expect(result.references).toHaveLength(0);
    });

    it('should extract reference components correctly', async () => {
      const documentText = 'Citation [1].';

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
      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' });

      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce([{ text: '[1]', type: 'numeric' }])
        .mockResolvedValueOnce(mockReferences);

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.references).toHaveLength(1);
      expect(result.references[0].components?.authors).toContain('Smith J');
      expect(result.references[0].components?.doi).toBe('10.1038/s41586-023-00001-0');
    });

    it('should return statistics about citations and references', async () => {
      const documentText = 'Document with [1] and [2].';

      const mockCitations = [
        { text: '[1]', type: 'numeric', paragraph: 1, startChar: 10 },
        { text: '[2]', type: 'numeric', paragraph: 1, startChar: 20 },
      ];

      const mockReferences = [
        { number: 1, rawText: 'Ref 1', authors: ['A'], year: '2020' },
        { number: 2, rawText: 'Ref 2', authors: ['B'], year: '2021' },
      ];

      vi.mocked(claudeService.generate).mockResolvedValue({ text: 'Vancouver' });
      vi.mocked(claudeService.generateJSON)
        .mockResolvedValueOnce(mockCitations)
        .mockResolvedValueOnce(mockReferences);

      const result = await aiCitationDetectorService.analyzeDocument(documentText);

      expect(result.statistics).toBeDefined();
      expect(result.statistics.totalCitations).toBe(2);
      expect(result.statistics.totalReferences).toBe(2);
    });
  });
});
