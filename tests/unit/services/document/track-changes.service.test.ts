/**
 * Track Changes Service Unit Tests
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentChangeStatus, DocumentChangeType } from '@prisma/client';

// Mock Prisma before importing service
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    documentChange: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { trackChangesService } from '../../../../src/services/document/track-changes.service';

describe('TrackChangesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('createChange', () => {
    it('should create a new tracked change', async () => {
      const mockChange = {
        id: 'change-1',
        documentId: 'doc-1',
        versionId: null,
        changeType: DocumentChangeType.INSERT,
        status: DocumentChangeStatus.PENDING,
        startOffset: 0,
        endOffset: 10,
        beforeText: null,
        afterText: 'New text',
        reason: 'Test change',
        sourceType: 'manual',
        metadata: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date(),
        createdBy: 'user-1',
      };

      vi.mocked(prisma.documentChange.create).mockResolvedValue(mockChange);

      const result = await trackChangesService.createChange({
        documentId: 'doc-1',
        changeType: DocumentChangeType.INSERT,
        startOffset: 0,
        endOffset: 10,
        afterText: 'New text',
        reason: 'Test change',
        sourceType: 'manual',
        createdBy: 'user-1',
      });

      expect(result.id).toBe('change-1');
      expect(result.status).toBe(DocumentChangeStatus.PENDING);
      expect(prisma.documentChange.create).toHaveBeenCalledOnce();
    });
  });

  describe('acceptChange', () => {
    it('should accept a pending change', async () => {
      const mockChange = {
        id: 'change-1',
        documentId: 'doc-1',
        versionId: null,
        changeType: DocumentChangeType.INSERT,
        status: DocumentChangeStatus.ACCEPTED,
        startOffset: 0,
        endOffset: 10,
        beforeText: null,
        afterText: 'New text',
        reason: null,
        sourceType: null,
        metadata: null,
        reviewedBy: 'user-1',
        reviewedAt: new Date(),
        createdAt: new Date(),
        createdBy: 'user-1',
      };

      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.documentChange.findUnique).mockResolvedValue(mockChange);

      const result = await trackChangesService.acceptChange('change-1', 'user-1');

      expect(result.status).toBe(DocumentChangeStatus.ACCEPTED);
      expect(result.reviewedBy).toBe('user-1');
    });

    it('should throw error when change not found', async () => {
      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 0 });
      vi.mocked(prisma.documentChange.findUnique).mockResolvedValue(null);

      await expect(
        trackChangesService.acceptChange('nonexistent', 'user-1')
      ).rejects.toThrow('Change nonexistent not found');
    });

    it('should throw error when change is not pending', async () => {
      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 0 });
      vi.mocked(prisma.documentChange.findUnique).mockResolvedValue({
        status: DocumentChangeStatus.ACCEPTED,
      } as any);

      await expect(
        trackChangesService.acceptChange('change-1', 'user-1')
      ).rejects.toThrow('Change change-1 is not in PENDING status');
    });
  });

  describe('rejectChange', () => {
    it('should reject a pending change', async () => {
      const mockChange = {
        id: 'change-1',
        documentId: 'doc-1',
        versionId: null,
        changeType: DocumentChangeType.INSERT,
        status: DocumentChangeStatus.REJECTED,
        startOffset: 0,
        endOffset: 10,
        beforeText: null,
        afterText: 'New text',
        reason: null,
        sourceType: null,
        metadata: null,
        reviewedBy: 'user-1',
        reviewedAt: new Date(),
        createdAt: new Date(),
        createdBy: 'user-1',
      };

      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.documentChange.findUnique).mockResolvedValue(mockChange);

      const result = await trackChangesService.rejectChange('change-1', 'user-1');

      expect(result.status).toBe(DocumentChangeStatus.REJECTED);
    });
  });

  describe('processBulkAction', () => {
    it('should accept multiple changes', async () => {
      const mockChanges = [
        { id: 'change-1', documentId: 'doc-1', status: DocumentChangeStatus.PENDING },
        { id: 'change-2', documentId: 'doc-1', status: DocumentChangeStatus.PENDING },
      ];

      vi.mocked(prisma.documentChange.findMany).mockResolvedValue(mockChanges as any);
      vi.mocked(prisma.$transaction).mockResolvedValue([
        { ...mockChanges[0], status: DocumentChangeStatus.ACCEPTED, reviewedBy: 'user-1', reviewedAt: new Date() },
        { ...mockChanges[1], status: DocumentChangeStatus.ACCEPTED, reviewedBy: 'user-1', reviewedAt: new Date() },
      ] as any);

      const result = await trackChangesService.processBulkAction({
        changeIds: ['change-1', 'change-2'],
        action: 'accept',
        reviewedBy: 'user-1',
        expectedDocumentId: 'doc-1',
      });

      expect(result).toHaveLength(2);
    });

    it('should throw error if changes belong to different document than expected', async () => {
      const mockChanges = [
        { id: 'change-1', documentId: 'doc-2', status: DocumentChangeStatus.PENDING },
      ];

      vi.mocked(prisma.documentChange.findMany).mockResolvedValue(mockChanges as any);

      await expect(
        trackChangesService.processBulkAction({
          changeIds: ['change-1'],
          action: 'accept',
          reviewedBy: 'user-1',
          expectedDocumentId: 'doc-1', // Different from doc-2
        })
      ).rejects.toThrow('Changes do not belong to the specified document');
    });

    it('should throw error if some change IDs are not found', async () => {
      vi.mocked(prisma.documentChange.findMany).mockResolvedValue([]);

      await expect(
        trackChangesService.processBulkAction({
          changeIds: ['change-1'],
          action: 'accept',
          reviewedBy: 'user-1',
          expectedDocumentId: 'doc-1',
        })
      ).rejects.toThrow('Some change IDs not found');
    });

    it('should throw error if changes are not pending', async () => {
      const mockChanges = [
        { id: 'change-1', documentId: 'doc-1', status: DocumentChangeStatus.ACCEPTED },
      ];

      vi.mocked(prisma.documentChange.findMany).mockResolvedValue(mockChanges as any);

      await expect(
        trackChangesService.processBulkAction({
          changeIds: ['change-1'],
          action: 'accept',
          reviewedBy: 'user-1',
          expectedDocumentId: 'doc-1',
        })
      ).rejects.toThrow('Cannot bulk accept changes that are not PENDING');
    });
  });

  describe('getChangeStats', () => {
    it('should return change statistics', async () => {
      vi.mocked(prisma.documentChange.count)
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(3)  // pending
        .mockResolvedValueOnce(5)  // accepted
        .mockResolvedValueOnce(1)  // rejected
        .mockResolvedValueOnce(1); // autoApplied

      vi.mocked(prisma.documentChange.groupBy)
        .mockResolvedValueOnce([
          { changeType: DocumentChangeType.INSERT, _count: { changeType: 5 } },
          { changeType: DocumentChangeType.DELETE, _count: { changeType: 3 } },
        ] as any)
        .mockResolvedValueOnce([
          { sourceType: 'manual', _count: { sourceType: 6 } },
          { sourceType: 'auto', _count: { sourceType: 4 } },
        ] as any);

      const result = await trackChangesService.getChangeStats('doc-1');

      expect(result.total).toBe(10);
      expect(result.pending).toBe(3);
      expect(result.accepted).toBe(5);
      expect(result.rejected).toBe(1);
      expect(result.byType[DocumentChangeType.INSERT]).toBe(5);
      expect(result.bySource['manual']).toBe(6);
    });
  });

  describe('acceptAllPending', () => {
    it('should accept all pending changes for a document', async () => {
      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 5 });

      const result = await trackChangesService.acceptAllPending('doc-1', 'user-1');

      expect(result).toBe(5);
      expect(prisma.documentChange.updateMany).toHaveBeenCalledWith({
        where: {
          documentId: 'doc-1',
          status: DocumentChangeStatus.PENDING,
        },
        data: expect.objectContaining({
          status: DocumentChangeStatus.ACCEPTED,
          reviewedBy: 'user-1',
        }),
      });
    });
  });

  describe('rejectAllPending', () => {
    it('should reject all pending changes for a document', async () => {
      vi.mocked(prisma.documentChange.updateMany).mockResolvedValue({ count: 3 });

      const result = await trackChangesService.rejectAllPending('doc-1', 'user-1');

      expect(result).toBe(3);
      expect(prisma.documentChange.updateMany).toHaveBeenCalledWith({
        where: {
          documentId: 'doc-1',
          status: DocumentChangeStatus.PENDING,
        },
        data: expect.objectContaining({
          status: DocumentChangeStatus.REJECTED,
          reviewedBy: 'user-1',
        }),
      });
    });
  });
});
