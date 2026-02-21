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
   * Get all changes for a document
   */
  async getChangesByDocument(
    documentId: string,
    status?: DocumentChangeStatus
  ): Promise<DocumentChange[]> {
    const changes = await prisma.documentChange.findMany({
      where: {
        documentId,
        ...(status && { status }),
      },
      orderBy: { startOffset: 'asc' },
    });

    return changes.map((c) => this.mapToDocumentChange(c));
  }

  /**
   * Get pending changes for a document
   */
  async getPendingChanges(documentId: string): Promise<DocumentChange[]> {
    return this.getChangesByDocument(documentId, DocumentChangeStatus.PENDING);
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
   * Get change statistics for a document
   */
  async getChangeStats(documentId: string): Promise<ChangeStats> {
    const changes = await prisma.documentChange.findMany({
      where: { documentId },
      select: {
        status: true,
        changeType: true,
        sourceType: true,
      },
    });

    const stats: ChangeStats = {
      total: changes.length,
      pending: 0,
      accepted: 0,
      rejected: 0,
      autoApplied: 0,
      byType: {} as Record<DocumentChangeType, number>,
      bySource: {},
    };

    for (const change of changes) {
      // Count by status
      switch (change.status) {
        case DocumentChangeStatus.PENDING:
          stats.pending++;
          break;
        case DocumentChangeStatus.ACCEPTED:
          stats.accepted++;
          break;
        case DocumentChangeStatus.REJECTED:
          stats.rejected++;
          break;
        case DocumentChangeStatus.AUTO_APPLIED:
          stats.autoApplied++;
          break;
      }

      // Count by type
      stats.byType[change.changeType] =
        (stats.byType[change.changeType] || 0) + 1;

      // Count by source
      const source = change.sourceType || 'unknown';
      stats.bySource[source] = (stats.bySource[source] || 0) + 1;
    }

    return stats;
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
