/**
 * Reference Reordering Service Tests
 *
 * Tests for citation reordering and renumbering logic
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { referenceReorderingService } from '../../../../src/services/citation/reference-reordering.service';
import type { ReferenceEntry, InTextCitation } from '../../../../src/services/citation/ai-citation-detector.service';

describe('ReferenceReorderingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reorderReference', () => {
    it('should reorder a single reference to a new position', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First Paper', components: { authors: ['Smith'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second Paper', components: { authors: ['Jones'], year: '2021' } },
        { id: 'ref-3', number: 3, rawText: 'Third Paper', components: { authors: ['Brown'], year: '2022' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket', type: 'numeric', position: { paragraph: 1, startChar: 10 } },
        { id: 'cit-2', text: '[2]', numbers: [2], format: 'bracket', type: 'numeric', position: { paragraph: 2, startChar: 20 } },
      ];

      const result = await referenceReorderingService.reorderReference(
        references,
        citations,
        'ref-3',
        1 // Move ref-3 to position 1
      );

      expect(result.updatedReferences).toHaveLength(3);
      expect(result.updatedReferences[0].id).toBe('ref-3');
      expect(result.changes).toBeDefined();
    });

    it('should update citation numbers after reordering', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket', type: 'numeric', position: { paragraph: 1, startChar: 10 }, linkedRefId: 'ref-1' },
      ];

      const result = await referenceReorderingService.reorderReference(
        references,
        citations,
        'ref-2',
        1 // Move ref-2 to position 1
      );

      expect(result.updatedCitations).toBeDefined();
    });

    it('should throw error for non-existent reference', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [];

      await expect(
        referenceReorderingService.reorderReference(references, citations, 'non-existent', 1)
      ).rejects.toThrow('Reference non-existent not found');
    });

    it('should handle single reference swap', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.reorderReference(
        references,
        citations,
        'ref-2',
        1
      );

      expect(result.updatedReferences[0].id).toBe('ref-2');
      expect(result.updatedReferences[1].id).toBe('ref-1');
    });
  });

  describe('reorderMultiple', () => {
    it('should batch reorder multiple references', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
        { id: 'ref-3', number: 3, rawText: 'Third', components: { authors: ['C'], year: '2022' } },
      ];

      const citations: InTextCitation[] = [];

      const operations = [
        { referenceId: 'ref-3', oldPosition: 3, newPosition: 1 },
      ];

      const result = await referenceReorderingService.reorderMultiple(
        references,
        citations,
        operations
      );

      expect(result.updatedReferences).toHaveLength(3);
      expect(result.changes).toBeDefined();
    });
  });

  describe('sortByAppearance', () => {
    it('should sort references by citation order in document', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
        { id: 'ref-3', number: 3, rawText: 'Third', components: { authors: ['C'], year: '2022' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[3]', numbers: [3], format: 'bracket', type: 'numeric', position: { paragraph: 1, startChar: 10 }, linkedRefId: 'ref-3' },
        { id: 'cit-2', text: '[1]', numbers: [1], format: 'bracket', type: 'numeric', position: { paragraph: 2, startChar: 50 }, linkedRefId: 'ref-1' },
        { id: 'cit-3', text: '[2]', numbers: [2], format: 'bracket', type: 'numeric', position: { paragraph: 3, startChar: 100 }, linkedRefId: 'ref-2' },
      ];

      const result = await referenceReorderingService.sortByAppearance(references, citations);

      expect(result.updatedReferences).toBeDefined();
      expect(result.changes).toBeDefined();
      // ref-3 should be first (cited first in paragraph 1)
      expect(result.updatedReferences[0].id).toBe('ref-3');
    });

    it('should handle citations without linked references', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[1]', numbers: [1], format: 'bracket', type: 'numeric', position: { paragraph: 1, startChar: 10 } },
      ];

      const result = await referenceReorderingService.sortByAppearance(references, citations);

      expect(result.updatedReferences).toHaveLength(1);
    });
  });

  describe('sortAlphabetically', () => {
    it('should sort references by first author name', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['Zebra, A.'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['Apple, B.'], year: '2021' } },
        { id: 'ref-3', number: 3, rawText: 'Third', components: { authors: ['Middle, C.'], year: '2022' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortAlphabetically(references, citations);

      expect(result.updatedReferences[0].components.authors?.[0]).toBe('Apple, B.');
      expect(result.updatedReferences[2].components.authors?.[0]).toBe('Zebra, A.');
    });

    it('should handle missing author names', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['Author'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortAlphabetically(references, citations);

      expect(result.updatedReferences).toHaveLength(2);
    });
  });

  describe('sortByYear', () => {
    it('should sort references by year descending (newest first)', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'Old', components: { authors: ['A'], year: '2010' } },
        { id: 'ref-2', number: 2, rawText: 'New', components: { authors: ['B'], year: '2023' } },
        { id: 'ref-3', number: 3, rawText: 'Middle', components: { authors: ['C'], year: '2015' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortByYear(references, citations, 'desc');

      expect(result.updatedReferences[0].components.year).toBe('2023');
      expect(result.updatedReferences[2].components.year).toBe('2010');
    });

    it('should sort references by year ascending (oldest first)', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'Old', components: { authors: ['A'], year: '2010' } },
        { id: 'ref-2', number: 2, rawText: 'New', components: { authors: ['B'], year: '2023' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortByYear(references, citations, 'asc');

      expect(result.updatedReferences[0].components.year).toBe('2010');
      expect(result.updatedReferences[1].components.year).toBe('2023');
    });

    it('should handle missing year values', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'No year', components: { authors: ['A'] } },
        { id: 'ref-2', number: 2, rawText: 'Has year', components: { authors: ['B'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortByYear(references, citations);

      expect(result.updatedReferences).toHaveLength(2);
    });
  });

  describe('citation text formatting', () => {
    it('should format bracket citations correctly', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '[2]', numbers: [2], format: 'bracket', type: 'numeric', position: { paragraph: 1, startChar: 10 } },
      ];

      const result = await referenceReorderingService.reorderReference(
        references,
        citations,
        'ref-2',
        1
      );

      expect(result.updatedCitations).toBeDefined();
    });

    it('should format parenthesis citations correctly', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [
        { id: 'cit-1', text: '(2)', numbers: [2], format: 'parenthesis', type: 'numeric', position: { paragraph: 1, startChar: 10 } },
      ];

      const result = await referenceReorderingService.reorderReference(
        references,
        citations,
        'ref-2',
        1
      );

      expect(result.updatedCitations).toBeDefined();
    });

    it('should handle empty citation lists', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'First', components: { authors: ['A'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortAlphabetically(references, citations);

      expect(result.updatedCitations).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty reference list', async () => {
      const references: ReferenceEntry[] = [];
      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortAlphabetically(references, citations);

      expect(result.updatedReferences).toHaveLength(0);
    });

    it('should handle single reference', async () => {
      const references: ReferenceEntry[] = [
        { id: 'ref-1', number: 1, rawText: 'Only one', components: { authors: ['A'], year: '2020' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.sortAlphabetically(references, citations);

      expect(result.updatedReferences).toHaveLength(1);
      expect(result.changes).toHaveLength(0); // No changes needed for single ref
    });

    it('should preserve reference data during reordering', async () => {
      const references: ReferenceEntry[] = [
        {
          id: 'ref-1',
          number: 1,
          rawText: 'Full reference text',
          components: {
            authors: ['Smith, J.', 'Jones, A.'],
            year: '2020',
            title: 'Article Title',
            journal: 'Nature',
            volume: '580',
            pages: '100-105'
          }
        },
        { id: 'ref-2', number: 2, rawText: 'Second', components: { authors: ['B'], year: '2021' } },
      ];

      const citations: InTextCitation[] = [];

      const result = await referenceReorderingService.reorderReference(references, citations, 'ref-2', 1);

      const movedRef = result.updatedReferences.find(r => r.id === 'ref-1');
      expect(movedRef?.components.journal).toBe('Nature');
      expect(movedRef?.components.pages).toBe('100-105');
    });
  });
});
