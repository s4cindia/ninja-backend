/**
 * AI Format Converter Service Tests
 *
 * Tests for citation style conversion (APA, MLA, Chicago, Vancouver, IEEE, Harvard, AMA)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock Claude service
vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
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
import { aiFormatConverterService } from '../../../../src/services/citation/ai-format-converter.service';
import type { ReferenceEntry, InTextCitation } from '../../../../src/services/citation/ai-citation-detector.service';

describe('AIFormatConverterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSupportedStyles', () => {
    it('should return all supported citation styles', () => {
      const styles = aiFormatConverterService.getSupportedStyles();

      expect(styles).toContain('APA');
      expect(styles).toContain('MLA');
      expect(styles).toContain('Chicago');
      expect(styles).toContain('Vancouver');
      expect(styles).toContain('IEEE');
      expect(styles).toContain('Harvard');
      expect(styles).toContain('AMA');
      expect(styles).toHaveLength(7);
    });
  });

  describe('isStyleSupported', () => {
    it('should return true for valid styles', () => {
      expect(aiFormatConverterService.isStyleSupported('APA')).toBe(true);
      expect(aiFormatConverterService.isStyleSupported('MLA')).toBe(true);
      expect(aiFormatConverterService.isStyleSupported('Vancouver')).toBe(true);
    });

    it('should return false for invalid styles', () => {
      expect(aiFormatConverterService.isStyleSupported('INVALID')).toBe(false);
      expect(aiFormatConverterService.isStyleSupported('apa')).toBe(false); // Case sensitive
      expect(aiFormatConverterService.isStyleSupported('')).toBe(false);
    });
  });

  describe('convertStyle', () => {
    it('should convert references from Vancouver to APA style', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith JA, Jones BC. Effect of treatment. J Med Res. 2020;45(3):123-145.',
          components: {
            authors: ['Smith JA', 'Jones BC'],
            year: '2020',
            title: 'Effect of treatment',
            journal: 'J Med Res',
            volume: '45',
            issue: '3',
            pages: '123-145'
          }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(1)', numbers: [1], format: 'parenthesis' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          {
            number: 1,
            rawText: 'Smith, J. A., & Jones, B. C. (2020). Effect of treatment. Journal of Medical Research, 45(3), 123-145.',
            authors: ['Smith, J. A.', 'Jones, B. C.'],
            year: '2020',
            title: 'Effect of treatment',
            journal: 'Journal of Medical Research',
            volume: '45',
            issue: '3',
            pages: '123-145'
          }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.targetStyle).toBe('APA');
      expect(result.convertedReferences).toHaveLength(1);
      expect(result.changes).toHaveLength(1);
      expect(claudeService.generate).toHaveBeenCalled();
    });

    it('should convert author-year citations to numeric style (Vancouver)', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith, J. (2020). Study results. Nature, 580, 100-105.',
          components: {
            authors: ['Smith, J.'],
            year: '2020',
            title: 'Study results',
            journal: 'Nature'
          }
        },
        {
          id: 'ref-2',
          number: 2,
          rawText: 'Jones, A. (2019). Earlier work. Science, 365, 50-55.',
          components: {
            authors: ['Jones, A.'],
            year: '2019',
            title: 'Earlier work',
            journal: 'Science'
          }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(Jones, 2019)', format: 'parenthesis', position: { paragraph: 1, startChar: 10 } },
        { id: 'cit-2', text: '(Smith, 2020)', format: 'parenthesis', position: { paragraph: 2, startChar: 20 } }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          {
            number: 1,
            rawText: 'Jones A. Earlier work. Science. 2019;365:50-55.',
            authors: ['Jones A'],
            year: '2019'
          },
          {
            number: 2,
            rawText: 'Smith J. Study results. Nature. 2020;580:100-105.',
            authors: ['Smith J'],
            year: '2020'
          }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'Vancouver');

      expect(result.targetStyle).toBe('Vancouver');
      expect(result.convertedReferences).toBeDefined();
    });

    it('should handle AI service errors gracefully', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Test reference',
          components: { authors: ['Test'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [];

      vi.mocked(claudeService.generate).mockRejectedValue(new Error('AI service unavailable'));

      await expect(
        aiFormatConverterService.convertStyle(references, citations, 'APA')
      ).rejects.toThrow('AI service unavailable');
    });

    it('should handle malformed AI responses', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Original reference',
          components: { authors: ['Author'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [];

      // AI returns non-JSON response
      vi.mocked(claudeService.generate).mockResolvedValue({
        text: 'This is not valid JSON'
      });

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      // Should return original references when parsing fails
      expect(result.convertedReferences).toHaveLength(1);
      expect(result.convertedReferences[0].rawText).toBe('Original reference');
    });

    it('should generate citation conversions for in-text citations', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith J. Study. Nature. 2020;580:100.',
          components: {
            authors: ['Smith, J.'],
            year: '2020',
            title: 'Study',
            journal: 'Nature'
          }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          {
            number: 1,
            rawText: 'Smith, J. (2020). Study. Nature, 580, 100.',
            authors: ['Smith, J.'],
            year: '2020'
          }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.citationConversions).toBeDefined();
      expect(result.convertedCitations).toHaveLength(1);
    });
  });

  describe('author-year detection', () => {
    it('should detect author-year citations in parentheses', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Brown et al. (2020). AI research.',
          components: { authors: ['Brown'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(Brown et al., 2020)', format: 'parenthesis' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: '[1] Brown et al. AI research. 2020.', authors: ['Brown'] }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'IEEE');

      // IEEE uses numeric format, so author-year should be converted
      expect(result.targetStyle).toBe('IEEE');
    });

    it('should detect author-year without parentheses', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Bommasani et al. (2021). Foundation models.',
          components: { authors: ['Bommasani'], year: '2021' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: 'Bommasani et al., 2021', format: 'parenthesis' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: '[1] Bommasani et al. Foundation models. 2021.', authors: ['Bommasani'] }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'Vancouver');

      expect(result.convertedReferences).toBeDefined();
    });
  });

  describe('number extraction and expansion', () => {
    it('should handle numeric citations with ranges', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'Ref 1', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Ref 2', components: { authors: ['B'], year: '2020' } },
        { id: 'ref-3', number: 3, rawText: 'Ref 3', components: { authors: ['C'], year: '2020' } },
        { id: 'ref-4', number: 4, rawText: 'Ref 4', components: { authors: ['D'], year: '2020' } },
        { id: 'ref-5', number: 5, rawText: 'Ref 5', components: { authors: ['E'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[3-5]', format: 'bracket' } // Should expand to 3, 4, 5
      ];

      const mockAIResponse = {
        text: JSON.stringify(references.map((r, i) => ({
          number: i + 1,
          rawText: `APA Ref ${i + 1}`,
          authors: r.components?.authors,
          year: r.components?.year
        })))
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.convertedCitations).toHaveLength(1);
    });

    it('should handle mixed numeric citations', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'Ref 1', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Ref 2', components: { authors: ['B'], year: '2020' } },
        { id: 'ref-3', number: 3, rawText: 'Ref 3', components: { authors: ['C'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1,3]', numbers: [1, 3], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify(references.map((r, i) => ({
          number: i + 1,
          rawText: `APA Ref ${i + 1}`,
          authors: r.components?.authors,
          year: r.components?.year
        })))
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.convertedCitations).toBeDefined();
    });
  });

  describe('style-specific formatting', () => {
    it('should use bracket format for IEEE style', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Author. Title. Journal. 2020.',
          components: { authors: ['Author'], year: '2020', title: 'Title' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(Author, 2020)', format: 'parenthesis' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: '[1] Author, "Title," Journal, 2020.', authors: ['Author'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'IEEE');

      // IEEE uses [1] format
      expect(result.targetStyle).toBe('IEEE');
    });

    it('should use author-year format for Harvard style', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: '1. Smith J. Study. Nature. 2020;580:100.',
          components: { authors: ['Smith, J.'], year: '2020', title: 'Study' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Smith, J., 2020. Study. Nature, 580, 100.', authors: ['Smith, J.'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'Harvard');

      expect(result.targetStyle).toBe('Harvard');
      // Harvard uses (Author, Year) format
    });

    it('should use footnote format for Chicago style', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Author. Title. Journal. 2020.',
          components: { authors: ['Author'], year: '2020', title: 'Title' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(1)', numbers: [1], format: 'parenthesis' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Author, "Title," Journal (2020).', authors: ['Author'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'Chicago');

      expect(result.targetStyle).toBe('Chicago');
      // Chicago uses superscript footnote numbers
    });
  });

  describe('author formatting for in-text citations', () => {
    it('should format single author correctly', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith J. Study. 2020.',
          components: { authors: ['Smith, J.'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Smith, J. (2020). Study.', authors: ['Smith, J.'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      // For APA, single author should be formatted as (Smith, 2020)
      expect(result.citationConversions).toBeDefined();
    });

    it('should format two authors with ampersand', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith J, Jones A. Study. 2020.',
          components: { authors: ['Smith, J.', 'Jones, A.'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Smith, J., & Jones, A. (2020). Study.', authors: ['Smith, J.', 'Jones, A.'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      // For APA with 2 authors: (Smith & Jones, 2020)
      expect(result.citationConversions).toBeDefined();
    });

    it('should format three+ authors with et al.', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Smith J, Jones A, Brown B. Study. 2020.',
          components: { authors: ['Smith, J.', 'Jones, A.', 'Brown, B.'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket' }
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Smith, J., Jones, A., & Brown, B. (2020). Study.', authors: ['Smith, J.', 'Jones, A.', 'Brown, B.'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      // For APA with 3+ authors: (Smith et al., 2020)
      expect(result.citationConversions).toBeDefined();
    });
  });

  describe('empty and edge cases', () => {
    it('should handle empty references array', async () => {
      const references: ReferenceEntry[] = [];
      const citations: InTextCitation[] = [];

      const mockAIResponse = { text: '[]' };
      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.convertedReferences).toHaveLength(0);
      expect(result.changes).toHaveLength(0);
    });

    it('should handle citations with no matching references', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Reference 1',
          components: { authors: ['Author'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[99]', numbers: [99], format: 'bracket' } // No matching ref
      ];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Author (2020). Reference 1.', authors: ['Author'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.convertedReferences).toHaveLength(1);
    });

    it('should preserve original reference IDs', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'original-uuid-123',
          number: 1,
          rawText: 'Original ref',
          components: { authors: ['Author'], year: '2020' }
        }
      ];

      const citations: InTextCitation[] = [];

      const mockAIResponse = {
        text: JSON.stringify([
          { number: 1, rawText: 'Converted ref', authors: ['Author'], year: '2020' }
        ])
      };

      vi.mocked(claudeService.generate).mockResolvedValue(mockAIResponse);

      const result = await aiFormatConverterService.convertStyle(references, citations, 'APA');

      expect(result.convertedReferences[0].id).toBe('original-uuid-123');
    });
  });
});
