import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DocumentChangeType, DocumentChangeStatus } from '@prisma/client';

export interface CreateChangeInput {
  documentId: string;
  versionId?: string;
  changeType: DocumentChangeType;
  startOffset: number;
  endOffset: number;
  beforeText?: string;
  afterText?: string;
  reason?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface DocumentChange {
  id: string;
  documentId: string;
  versionId: string | null;
  changeType: DocumentChangeType;
  status: DocumentChangeStatus;
  startOffset: number;
  endOffset: number;
  beforeText: string | null;
  afterText: string | null;
  reason: string | null;
  sourceType: string | null;
  metadata: Record<string, unknown> | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

export interface BulkChangeAction {
  changeIds: string[];
  action: 'accept' | 'reject';
  reviewedBy: string;
}

export interface ChangeStats {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  autoApplied: number;
  byType: Record<DocumentChangeType, number>;
  bySource: Record<string, number>;
}

class TrackChangesService {
  /**
   * Create a new tracked change
   */
  async createChange(input: CreateChangeInput): Promise<DocumentChange> {
    const change = await prisma.documentChange.create({
      data: {
        documentId: input.documentId,
        versionId: input.versionId,
        changeType: input.changeType,
        status: DocumentChangeStatus.PENDING,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        beforeText: input.beforeText,
        afterText: input.afterText,
        reason: input.reason,
        sourceType: input.sourceType,
        metadata: input.metadata as import('@prisma/client').Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });

    logger.info(
      `[TrackChanges] Created change ${change.id} for document ${input.documentId}`
    );

    return this.mapToDocumentChange(change);
  }

  /**
   * Create multiple changes at once (batch)
   */
  async createChanges(inputs: CreateChangeInput[]): Promise<DocumentChange[]> {
    const changes = await prisma.$transaction(
      inputs.map((input) =>
        prisma.documentChange.create({
          data: {
            documentId: input.documentId,
            versionId: input.versionId,
            changeType: input.changeType,
            status: DocumentChangeStatus.PENDING,
            startOffset: input.startOffset,
            endOffset: input.endOffset,
            beforeText: input.beforeText,
            afterText: input.afterText,
            reason: input.reason,
            sourceType: input.sourceType,
            metadata: input.metadata as import('@prisma/client').Prisma.InputJsonValue,
            createdBy: input.createdBy,
          },
        })
      )
    );

    logger.info(
      `[TrackChanges] Created ${changes.length} changes for document ${inputs[0]?.documentId}`
    );

    return changes.map((c) => this.mapToDocumentChange(c));
  }

  /**
   * Get all changes for a document with pagination
   */
  async getChangesByDocument(
    documentId: string,
    options?: { status?: DocumentChangeStatus; limit?: number; offset?: number }
  ): Promise<{ changes: DocumentChange[]; total: number }> {
    const limit = Math.min(options?.limit || 100, 500); // Max 500 per page
    const offset = options?.offset || 0;

    const where = {
      documentId,
      ...(options?.status && { status: options.status }),
    };

    const [changes, total] = await Promise.all([
      prisma.documentChange.findMany({
        where,
        orderBy: { startOffset: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.documentChange.count({ where }),
    ]);

    return {
      changes: changes.map((c) => this.mapToDocumentChange(c)),
      total,
    };
  }

  /**
   * Get pending changes for a document
   */
  async getPendingChanges(documentId: string): Promise<DocumentChange[]> {
    const result = await this.getChangesByDocument(documentId, {
      status: DocumentChangeStatus.PENDING,
    });
    return result.changes;
  }

  /**
   * Accept a change
   */
  async acceptChange(
    changeId: string,
    reviewedBy: string
  ): Promise<DocumentChange> {
    const change = await prisma.documentChange.update({
      where: { id: changeId },
      data: {
        status: DocumentChangeStatus.ACCEPTED,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    logger.info(`[TrackChanges] Accepted change ${changeId}`);

    return this.mapToDocumentChange(change);
  }

  /**
   * Reject a change
   */
  async rejectChange(
    changeId: string,
    reviewedBy: string
  ): Promise<DocumentChange> {
    const change = await prisma.documentChange.update({
      where: { id: changeId },
      data: {
        status: DocumentChangeStatus.REJECTED,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    logger.info(`[TrackChanges] Rejected change ${changeId}`);

    return this.mapToDocumentChange(change);
  }

  /**
   * Process bulk actions (accept/reject multiple changes)
   */
  async processBulkAction(action: BulkChangeAction): Promise<DocumentChange[]> {
    // First, verify all IDs exist and belong to the same document
    const existingChanges = await prisma.documentChange.findMany({
      where: { id: { in: action.changeIds } },
      select: { id: true, documentId: true },
    });

    // Check if all requested IDs were found
    if (existingChanges.length !== action.changeIds.length) {
      const foundIds = new Set(existingChanges.map((c) => c.id));
      const missingIds = action.changeIds.filter((id) => !foundIds.has(id));
      throw new Error(`Some change IDs not found: ${missingIds.join(', ')}`);
    }

    // Verify all changes belong to the same document
    const documentIds = new Set(existingChanges.map((c) => c.documentId));
    if (documentIds.size > 1) {
      throw new Error('All changes must belong to the same document');
    }

    const status =
      action.action === 'accept'
        ? DocumentChangeStatus.ACCEPTED
        : DocumentChangeStatus.REJECTED;

    const changes = await prisma.$transaction(
      action.changeIds.map((id) =>
        prisma.documentChange.update({
          where: { id },
          data: {
            status,
            reviewedBy: action.reviewedBy,
            reviewedAt: new Date(),
          },
        })
      )
    );

    logger.info(
      `[TrackChanges] Bulk ${action.action} ${changes.length} changes`
    );

    return changes.map((c) => this.mapToDocumentChange(c));
  }

  /**
   * Accept all pending changes for a document
   */
  async acceptAllPending(
    documentId: string,
    reviewedBy: string
  ): Promise<number> {
    const result = await prisma.documentChange.updateMany({
      where: {
        documentId,
        status: DocumentChangeStatus.PENDING,
      },
      data: {
        status: DocumentChangeStatus.ACCEPTED,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    logger.info(
      `[TrackChanges] Accepted all ${result.count} pending changes for document ${documentId}`
    );

    return result.count;
  }

  /**
   * Reject all pending changes for a document
   */
  async rejectAllPending(
    documentId: string,
    reviewedBy: string
  ): Promise<number> {
    const result = await prisma.documentChange.updateMany({
      where: {
        documentId,
        status: DocumentChangeStatus.PENDING,
      },
      data: {
        status: DocumentChangeStatus.REJECTED,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    logger.info(
      `[TrackChanges] Rejected all ${result.count} pending changes for document ${documentId}`
    );

    return result.count;
  }

  /**
   * Get change statistics for a document using aggregation queries
   */
  async getChangeStats(documentId: string): Promise<ChangeStats> {
    // Use separate count queries for better performance
    const [
      total,
      pending,
      accepted,
      rejected,
      autoApplied,
      byTypeResults,
      bySourceResults,
    ] = await Promise.all([
      prisma.documentChange.count({ where: { documentId } }),
      prisma.documentChange.count({
        where: { documentId, status: DocumentChangeStatus.PENDING },
      }),
      prisma.documentChange.count({
        where: { documentId, status: DocumentChangeStatus.ACCEPTED },
      }),
      prisma.documentChange.count({
        where: { documentId, status: DocumentChangeStatus.REJECTED },
      }),
      prisma.documentChange.count({
        where: { documentId, status: DocumentChangeStatus.AUTO_APPLIED },
      }),
      prisma.documentChange.groupBy({
        by: ['changeType'],
        where: { documentId },
        _count: { changeType: true },
      }),
      prisma.documentChange.groupBy({
        by: ['sourceType'],
        where: { documentId },
        _count: { sourceType: true },
      }),
    ]);

    // Build byType map
    const byType: Record<DocumentChangeType, number> = {} as Record<DocumentChangeType, number>;
    for (const result of byTypeResults) {
      byType[result.changeType] = result._count.changeType;
    }

    // Build bySource map
    const bySource: Record<string, number> = {};
    for (const result of bySourceResults) {
      const source = result.sourceType || 'unknown';
      bySource[source] = result._count.sourceType;
    }

    return {
      total,
      pending,
      accepted,
      rejected,
      autoApplied,
      byType,
      bySource,
    };
  }

  /**
   * Delete all changes for a document
   */
  async deleteChanges(documentId: string): Promise<number> {
    const result = await prisma.documentChange.deleteMany({
      where: { documentId },
    });

    logger.info(
      `[TrackChanges] Deleted ${result.count} changes for document ${documentId}`
    );

    return result.count;
  }

  /**
   * Get a single change by ID
   */
  async getChange(changeId: string): Promise<DocumentChange | null> {
    const change = await prisma.documentChange.findUnique({
      where: { id: changeId },
    });

    if (!change) return null;

    return this.mapToDocumentChange(change);
  }

  /**
   * Map Prisma model to DocumentChange interface
   */
  private mapToDocumentChange(
    change: import('@prisma/client').DocumentChange
  ): DocumentChange {
    return {
      id: change.id,
      documentId: change.documentId,
      versionId: change.versionId,
      changeType: change.changeType,
      status: change.status,
      startOffset: change.startOffset,
      endOffset: change.endOffset,
      beforeText: change.beforeText,
      afterText: change.afterText,
      reason: change.reason,
      sourceType: change.sourceType,
      metadata: change.metadata as Record<string, unknown> | null,
      reviewedBy: change.reviewedBy,
      reviewedAt: change.reviewedAt,
      createdAt: change.createdAt,
      createdBy: change.createdBy,
    };
  }
}

export const trackChangesService = new TrackChangesService();

// Export bound methods
export const createChange = trackChangesService.createChange.bind(
  trackChangesService
);
export const createChanges = trackChangesService.createChanges.bind(
  trackChangesService
);
export const getChangesByDocument = trackChangesService.getChangesByDocument.bind(
  trackChangesService
);
export const getPendingChanges = trackChangesService.getPendingChanges.bind(
  trackChangesService
);
export const acceptChange = trackChangesService.acceptChange.bind(
  trackChangesService
);
export const rejectChange = trackChangesService.rejectChange.bind(
  trackChangesService
);
export const processBulkAction = trackChangesService.processBulkAction.bind(
  trackChangesService
);
export const acceptAllPending = trackChangesService.acceptAllPending.bind(
  trackChangesService
);
export const rejectAllPending = trackChangesService.rejectAllPending.bind(
  trackChangesService
);
export const getChangeStats = trackChangesService.getChangeStats.bind(
  trackChangesService
);
