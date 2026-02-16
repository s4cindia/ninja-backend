/**
 * Reference List Service Tests
 *
 * Tests for reference list generation and batch operations
 * Includes tests for N+1 query prevention (batch inserts/updates)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../../../../src/lib/prisma', () => {
  const mockPrisma = {
    editorialDocument: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    citation: {
      findMany: vi.fn(),
    },
    referenceListEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    referenceListEntryCitation: {
      createMany: vi.fn(),
    },
    citationStyleGuide: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((operations: any[]) => Promise.all(operations)),
  };
  return { default: mockPrisma };
});

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
    generate: vi.fn(),
    generateJSON: vi.fn(),
  },
}));

vi.mock('../../../../src/services/shared', () => ({
  editorialAi: {
    generateReferenceEntriesChunked: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/crossref.service', () => ({
  crossRefService: {
    lookupByDoi: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/style-rules.service', () => ({
  styleRulesService: {
    getRulesForStyle: vi.fn().mockReturnValue([]),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { editorialAi } from '../../../../src/services/shared';
import { crossRefService } from '../../../../src/services/citation/crossref.service';
import { referenceListService } from '../../../../src/services/citation/reference-list.service';

describe('ReferenceListService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getReferenceList', () => {
    it('should return null when no entries exist', async () => {
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: 'tenant-1',
        referenceListStyle: 'apa7',
      } as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([]);

      const result = await referenceListService.getReferenceList('doc-1', 'apa7', 'tenant-1');

      expect(result).toBeNull();
    });

    it('should return formatted reference list', async () => {
      const mockEntries = [
        {
          id: 'entry-1',
          documentId: 'doc-1',
          sortKey: 'smith2023',
          authors: [{ firstName: 'John', lastName: 'Smith' }],
          year: '2023',
          title: 'Paper Title',
          sourceType: 'journal',
          formattedApa: 'Smith, J. (2023). Paper Title.',
        },
      ];

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: 'tenant-1',
        referenceListStyle: 'apa7',
      } as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue(mockEntries as any);

      const result = await referenceListService.getReferenceList('doc-1', 'apa7', 'tenant-1');

      expect(result).not.toBeNull();
      expect(result?.entries).toHaveLength(1);
      expect(result?.styleCode).toBe('apa7');
    });

    it('should throw NotFound when document does not exist', async () => {
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await expect(
        referenceListService.getReferenceList('nonexistent', 'apa7', 'tenant-1')
      ).rejects.toThrow('Document not found');
    });
  });

  describe('generateReferenceList', () => {
    it('should generate reference list from citations', async () => {
      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        documentContent: { fullText: 'Document text with citations.' },
        referenceListStyle: 'apa7',
      };

      const mockCitations = [
        { id: 'cit-1', rawText: '(Smith, 2023)', citationType: 'PARENTHETICAL' },
      ];

      const mockAiResult = {
        entries: [
          {
            citationIds: ['cit-1'],
            authors: [{ firstName: 'John', lastName: 'Smith' }],
            year: '2023',
            title: 'Example Paper',
            sourceType: 'journal',
            confidence: 0.8,
          },
        ],
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.citation.findMany).mockResolvedValue(mockCitations as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([]);
      vi.mocked(prisma.referenceListEntry.deleteMany).mockResolvedValue({ count: 0 });
      vi.mocked(editorialAi.generateReferenceEntriesChunked).mockResolvedValue(mockAiResult as any);
      vi.mocked(prisma.referenceListEntry.create).mockImplementation((args: any) =>
        Promise.resolve({ id: 'entry-1', ...args.data })
      );
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue(mockDocument as any);

      const result = await referenceListService.generateReferenceList('doc-1', 'apa7', 'tenant-1');

      expect(result).toBeDefined();
      expect(result.entries).toHaveLength(1);
      expect(result.documentId).toBe('doc-1');
    });

    it('should throw error when no citations found', async () => {
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: 'tenant-1',
      } as any);
      vi.mocked(prisma.citation.findMany).mockResolvedValue([]);

      await expect(
        referenceListService.generateReferenceList('doc-1', 'apa7', 'tenant-1')
      ).rejects.toThrow('No citations found');
    });

    it('should use batch transaction for creating entries', async () => {
      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        documentContent: { fullText: 'Text' },
      };

      const mockCitations = [
        { id: 'cit-1', rawText: '(A, 2020)', citationType: 'PARENTHETICAL' },
        { id: 'cit-2', rawText: '(B, 2021)', citationType: 'PARENTHETICAL' },
      ];

      const mockAiResult = {
        entries: [
          { citationIds: ['cit-1'], authors: [{ lastName: 'A' }], year: '2020', title: 'Paper A', confidence: 0.8 },
          { citationIds: ['cit-2'], authors: [{ lastName: 'B' }], year: '2021', title: 'Paper B', confidence: 0.8 },
        ],
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.citation.findMany).mockResolvedValue(mockCitations as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([]);
      vi.mocked(prisma.referenceListEntry.deleteMany).mockResolvedValue({ count: 0 });
      vi.mocked(editorialAi.generateReferenceEntriesChunked).mockResolvedValue(mockAiResult as any);
      vi.mocked(prisma.referenceListEntry.create).mockImplementation((args: any) =>
        Promise.resolve({ id: `entry-${Math.random()}`, ...args.data })
      );
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue(mockDocument as any);

      await referenceListService.generateReferenceList('doc-1', 'apa7', 'tenant-1');

      // Verify $transaction was called for batch insert
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should enrich entries with CrossRef data when DOI available', async () => {
      const mockDocument = { id: 'doc-1', tenantId: 'tenant-1', documentContent: { fullText: 'Text' } };
      const mockCitations = [{ id: 'cit-1', rawText: 'Citation', citationType: 'PARENTHETICAL' }];
      const mockAiResult = {
        entries: [
          {
            citationIds: ['cit-1'],
            authors: [{ lastName: 'Smith' }],
            year: '2023',
            title: 'Paper',
            doi: '10.1000/test',
            confidence: 0.7,
          },
        ],
      };

      const mockCrossRefData = {
        authors: [{ firstName: 'John', lastName: 'Smith' }],
        confidence: 0.95,
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.citation.findMany).mockResolvedValue(mockCitations as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([]);
      vi.mocked(prisma.referenceListEntry.deleteMany).mockResolvedValue({ count: 0 });
      vi.mocked(editorialAi.generateReferenceEntriesChunked).mockResolvedValue(mockAiResult as any);
      vi.mocked(crossRefService.lookupByDoi).mockResolvedValue(mockCrossRefData as any);
      vi.mocked(prisma.referenceListEntry.create).mockImplementation((args: any) =>
        Promise.resolve({ id: 'entry-1', ...args.data })
      );
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue(mockDocument as any);

      const result = await referenceListService.generateReferenceList('doc-1', 'apa7', 'tenant-1');

      expect(crossRefService.lookupByDoi).toHaveBeenCalledWith('10.1000/test');
      expect(result.stats.enrichedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('finalizeReferenceList', () => {
    it('should batch update entries that need formatting', async () => {
      const mockDocument = { id: 'doc-1', tenantId: 'tenant-1' };
      const mockEntries = [
        { id: 'entry-1', sortKey: 'a', formattedApa: null, authors: [], title: 'Paper 1' },
        { id: 'entry-2', sortKey: 'b', formattedApa: 'Already formatted', authors: [], title: 'Paper 2' },
        { id: 'entry-3', sortKey: 'c', formattedApa: null, authors: [], title: 'Paper 3' },
      ];

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue(mockEntries as any);
      vi.mocked(prisma.referenceListEntry.update).mockImplementation((args: any) =>
        Promise.resolve({ ...args.where, ...args.data })
      );
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.citationStyleGuide.findUnique).mockResolvedValue(null);

      await referenceListService.finalizeReferenceList('doc-1', 'apa7', 'tenant-1');

      // Should use $transaction for batch updates
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should skip already formatted entries', async () => {
      const mockDocument = { id: 'doc-1', tenantId: 'tenant-1' };
      const mockEntries = [
        { id: 'entry-1', sortKey: 'a', formattedApa: 'Already formatted', authors: [], title: 'Paper' },
      ];

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue(mockEntries as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue(mockDocument as any);

      await referenceListService.finalizeReferenceList('doc-1', 'apa7', 'tenant-1');

      // Should not call $transaction if nothing to update
      // (or call with empty array)
      const transactionCalls = vi.mocked(prisma.$transaction).mock.calls;
      if (transactionCalls.length > 0) {
        const operations = transactionCalls[0][0];
        expect(Array.isArray(operations) ? operations.length : 0).toBe(0);
      }
    });
  });

  describe('updateEntry', () => {
    it('should update reference entry', async () => {
      const mockDocument = { id: 'doc-1', tenantId: 'tenant-1' };
      const mockEntry = {
        id: 'entry-1',
        documentId: 'doc-1',
        document: mockDocument,  // Include the document relation
        authors: [{ lastName: 'Smith' }],
        year: '2023',
        title: 'Original Title',
        sortKey: 'smith2023',
        sourceType: 'journal',
        enrichmentSource: 'ai',
        enrichmentConfidence: 0.8,
      };

      // Reset mocks before this test
      vi.mocked(prisma.referenceListEntry.findUnique).mockReset();
      vi.mocked(prisma.editorialDocument.findFirst).mockReset();
      vi.mocked(prisma.referenceListEntry.update).mockReset();

      // findUnique includes the document relation
      vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockEntry as any);
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({
        ...mockEntry,
        title: 'Updated Title',
        isEdited: true,
      } as any);

      const result = await referenceListService.updateEntry('entry-1', {
        title: 'Updated Title',
      }, 'tenant-1');

      expect(result).toBeDefined();
      expect(prisma.referenceListEntry.update).toHaveBeenCalled();
    });
  });
});
