import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface ChangeLogEntry {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  reason?: string;
}

export interface DocumentSnapshot {
  documentId: string;
  content: string;
  metadata: {
    wordCount: number;
    pageCount?: number;
    title?: string;
    authors?: string[];
    language?: string;
  };
  references?: Array<{
    id: string;
    rawText: string;
    refNumber?: number;
  }>;
  citations?: Array<{
    id: string;
    rawText: string;
    referenceId?: string;
  }>;
  styleViolationCount?: number;
  complianceScore?: number;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  changeLog: ChangeLogEntry[];
  snapshot: DocumentSnapshot;
  snapshotType: 'full' | 'delta';
}

export interface VersionComparison {
  documentId: string;
  versionA: number;
  versionB: number;
  changes: ChangeLogEntry[];
  summary: {
    fieldsChanged: number;
    contentChanged: boolean;
    referencesChanged: number;
    citationsChanged: number;
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (Array.isArray(a) || Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = Object.keys(aObj);
  if (keys.length !== Object.keys(bObj).length) return false;

  return keys.every((key) => deepEqual(aObj[key], bObj[key]));
}

function generateChangeLog(
  previousSnapshot: DocumentSnapshot | null,
  currentSnapshot: DocumentSnapshot,
  reason?: string
): ChangeLogEntry[] {
  const changes: ChangeLogEntry[] = [];

  if (!previousSnapshot) {
    changes.push({
      field: 'document',
      previousValue: null,
      newValue: 'created',
      reason: reason || 'Initial version created',
    });
    return changes;
  }

  // Check content changes
  if (previousSnapshot.content !== currentSnapshot.content) {
    changes.push({
      field: 'content',
      previousValue: `${previousSnapshot.content.length} chars`,
      newValue: `${currentSnapshot.content.length} chars`,
      reason,
    });
  }

  // Check metadata changes
  if (!deepEqual(previousSnapshot.metadata, currentSnapshot.metadata)) {
    const prevMeta = previousSnapshot.metadata;
    const currMeta = currentSnapshot.metadata;

    if (prevMeta.wordCount !== currMeta.wordCount) {
      changes.push({
        field: 'metadata.wordCount',
        previousValue: prevMeta.wordCount,
        newValue: currMeta.wordCount,
        reason,
      });
    }
    if (prevMeta.title !== currMeta.title) {
      changes.push({
        field: 'metadata.title',
        previousValue: prevMeta.title,
        newValue: currMeta.title,
        reason,
      });
    }
    if (!deepEqual(prevMeta.authors, currMeta.authors)) {
      changes.push({
        field: 'metadata.authors',
        previousValue: prevMeta.authors,
        newValue: currMeta.authors,
        reason,
      });
    }
  }

  // Check references changes
  const prevRefs = previousSnapshot.references || [];
  const currRefs = currentSnapshot.references || [];

  if (prevRefs.length !== currRefs.length) {
    changes.push({
      field: 'references.count',
      previousValue: prevRefs.length,
      newValue: currRefs.length,
      reason,
    });
  }

  // Track individual reference changes
  const prevRefMap = new Map(prevRefs.map((r) => [r.id, r]));
  const currRefMap = new Map(currRefs.map((r) => [r.id, r]));

  for (const [refId, currRef] of currRefMap) {
    const prevRef = prevRefMap.get(refId);
    if (!prevRef) {
      changes.push({
        field: `reference.${refId}`,
        previousValue: null,
        newValue: 'added',
        reason,
      });
    } else if (prevRef.rawText !== currRef.rawText) {
      changes.push({
        field: `reference.${refId}.rawText`,
        previousValue: prevRef.rawText.substring(0, 50) + '...',
        newValue: currRef.rawText.substring(0, 50) + '...',
        reason,
      });
    }
  }

  for (const [refId] of prevRefMap) {
    if (!currRefMap.has(refId)) {
      changes.push({
        field: `reference.${refId}`,
        previousValue: 'existed',
        newValue: null,
        reason: reason || 'Reference removed',
      });
    }
  }

  // Check citations changes
  const prevCites = previousSnapshot.citations || [];
  const currCites = currentSnapshot.citations || [];

  if (prevCites.length !== currCites.length) {
    changes.push({
      field: 'citations.count',
      previousValue: prevCites.length,
      newValue: currCites.length,
      reason,
    });
  }

  // Track individual citation changes
  const prevCiteMap = new Map(prevCites.map((c) => [c.id, c]));
  const currCiteMap = new Map(currCites.map((c) => [c.id, c]));

  for (const [citeId, currCite] of currCiteMap) {
    const prevCite = prevCiteMap.get(citeId);
    if (!prevCite) {
      changes.push({
        field: `citation.${citeId}`,
        previousValue: null,
        newValue: 'added',
        reason,
      });
    } else if (prevCite.rawText !== currCite.rawText) {
      changes.push({
        field: `citation.${citeId}.rawText`,
        previousValue: prevCite.rawText.substring(0, 50) + (prevCite.rawText.length > 50 ? '...' : ''),
        newValue: currCite.rawText.substring(0, 50) + (currCite.rawText.length > 50 ? '...' : ''),
        reason,
      });
    }
  }

  for (const [citeId] of prevCiteMap) {
    if (!currCiteMap.has(citeId)) {
      changes.push({
        field: `citation.${citeId}`,
        previousValue: 'existed',
        newValue: null,
        reason: reason || 'Citation removed',
      });
    }
  }

  return changes;
}

class DocumentVersioningService {
  /**
   * Create a new version of a document
   */
  async createVersion(
    documentId: string,
    snapshot: DocumentSnapshot,
    userId: string,
    reason?: string
  ): Promise<DocumentVersion> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // Get latest version
          const latestVersions = await tx.documentVersion.findMany({
            where: { documentId },
            orderBy: { version: 'desc' },
            take: 1,
            select: { version: true, snapshot: true },
          });

          const newVersionNumber =
            latestVersions.length > 0 ? latestVersions[0].version + 1 : 1;

          const previousSnapshot =
            latestVersions.length > 0
              ? (latestVersions[0].snapshot as unknown as DocumentSnapshot)
              : null;

          const changeLog = generateChangeLog(previousSnapshot, snapshot, reason);

          const created = await tx.documentVersion.create({
            data: {
              documentId,
              version: newVersionNumber,
              createdBy: userId,
              changeLog:
                changeLog as unknown as import('@prisma/client').Prisma.InputJsonValue,
              snapshot:
                snapshot as unknown as import('@prisma/client').Prisma.InputJsonValue,
              snapshotType: 'full',
            },
          });

          logger.info(
            `[DocumentVersioning] Created version ${newVersionNumber} for document ${documentId}`
          );

          return {
            id: created.id,
            documentId: created.documentId,
            version: created.version,
            createdAt: created.createdAt,
            createdBy: created.createdBy,
            changeLog,
            snapshot,
            snapshotType: created.snapshotType as 'full' | 'delta',
          };
        });

        return result;
      } catch (error) {
        lastError = error as Error;

        // Check for unique constraint violation (P2002)
        const isPrismaError =
          error && typeof error === 'object' && 'code' in error;
        if (isPrismaError && (error as { code: string }).code === 'P2002') {
          if (attempt < maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, 100 * attempt)
            );
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to create version after retries');
  }

  /**
   * Get all versions of a document with pagination
   */
  async getVersions(
    documentId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ versions: DocumentVersion[]; total: number }> {
    const limit = Math.min(options?.limit || 50, 100); // Max 100 per page
    const offset = options?.offset || 0;

    const [versions, total] = await Promise.all([
      prisma.documentVersion.findMany({
        where: { documentId },
        orderBy: { version: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.documentVersion.count({
        where: { documentId },
      }),
    ]);

    return {
      versions: versions.map((v) => ({
        id: v.id,
        documentId: v.documentId,
        version: v.version,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
        changeLog: v.changeLog as unknown as ChangeLogEntry[],
        snapshot: v.snapshot as unknown as DocumentSnapshot,
        snapshotType: v.snapshotType as 'full' | 'delta',
      })),
      total,
    };
  }

  /**
   * Get a specific version
   */
  async getVersion(
    documentId: string,
    version: number
  ): Promise<DocumentVersion | null> {
    const found = await prisma.documentVersion.findFirst({
      where: { documentId, version },
    });

    if (!found) return null;

    return {
      id: found.id,
      documentId: found.documentId,
      version: found.version,
      createdAt: found.createdAt,
      createdBy: found.createdBy,
      changeLog: found.changeLog as unknown as ChangeLogEntry[],
      snapshot: found.snapshot as unknown as DocumentSnapshot,
      snapshotType: found.snapshotType as 'full' | 'delta',
    };
  }

  /**
   * Get the latest version
   */
  async getLatestVersion(documentId: string): Promise<DocumentVersion | null> {
    const found = await prisma.documentVersion.findFirst({
      where: { documentId },
      orderBy: { version: 'desc' },
    });

    if (!found) return null;

    return {
      id: found.id,
      documentId: found.documentId,
      version: found.version,
      createdAt: found.createdAt,
      createdBy: found.createdBy,
      changeLog: found.changeLog as unknown as ChangeLogEntry[],
      snapshot: found.snapshot as unknown as DocumentSnapshot,
      snapshotType: found.snapshotType as 'full' | 'delta',
    };
  }

  /**
   * Compare two versions
   */
  async compareVersions(
    documentId: string,
    versionA: number,
    versionB: number
  ): Promise<VersionComparison | null> {
    const [vA, vB] = await Promise.all([
      this.getVersion(documentId, versionA),
      this.getVersion(documentId, versionB),
    ]);

    if (!vA || !vB) return null;

    const changes = generateChangeLog(vA.snapshot, vB.snapshot);

    const referencesChanged = new Set(
      changes
        .filter((c) => c.field.startsWith('reference.'))
        .map((c) => c.field.split('.')[1])
    ).size;

    const citationsChanged = new Set(
      changes
        .filter((c) => c.field.startsWith('citation.'))
        .map((c) => c.field.split('.')[1])
    ).size;

    return {
      documentId,
      versionA,
      versionB,
      changes,
      summary: {
        fieldsChanged: changes.length,
        contentChanged: changes.some((c) => c.field === 'content'),
        referencesChanged,
        citationsChanged,
      },
    };
  }

  /**
   * Delete all versions for a document
   */
  async deleteVersions(documentId: string): Promise<boolean> {
    const result = await prisma.documentVersion.deleteMany({
      where: { documentId },
    });
    logger.info(
      `[DocumentVersioning] Deleted ${result.count} versions for document ${documentId}`
    );
    return result.count > 0;
  }

  /**
   * Get version count
   */
  async getVersionCount(documentId: string): Promise<number> {
    return prisma.documentVersion.count({
      where: { documentId },
    });
  }

  /**
   * Restore a document to a specific version
   */
  async restoreVersion(
    documentId: string,
    version: number,
    userId: string
  ): Promise<DocumentVersion | null> {
    const targetVersion = await this.getVersion(documentId, version);
    if (!targetVersion) return null;

    // Create a new version with the restored snapshot
    return this.createVersion(
      documentId,
      targetVersion.snapshot,
      userId,
      `Restored from version ${version}`
    );
  }
}

export const documentVersioningService = new DocumentVersioningService();

// Export bound methods for convenience
export const createVersion = documentVersioningService.createVersion.bind(
  documentVersioningService
);
export const getVersions = documentVersioningService.getVersions.bind(
  documentVersioningService
);
export const getVersion = documentVersioningService.getVersion.bind(
  documentVersioningService
);
export const getLatestVersion = documentVersioningService.getLatestVersion.bind(
  documentVersioningService
);
export const compareVersions = documentVersioningService.compareVersions.bind(
  documentVersioningService
);
export const deleteVersions = documentVersioningService.deleteVersions.bind(
  documentVersioningService
);
export const restoreVersion = documentVersioningService.restoreVersion.bind(
  documentVersioningService
);
