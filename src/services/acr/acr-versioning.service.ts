import prisma from '../../lib/prisma';
import { AcrDocument } from './acr-generator.service';

export interface ChangeLogEntry {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  reason?: string;
}

export interface AcrVersion {
  id: string;
  acrId: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  changeLog: ChangeLogEntry[];
  snapshot: AcrDocument;
}

export interface VersionComparison {
  acrId: string;
  versionA: number;
  versionB: number;
  changes: ChangeLogEntry[];
  summary: {
    fieldsChanged: number;
    criteriaChanged: number;
    statusChanged: boolean;
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
  
  return keys.every(key => deepEqual(aObj[key], bObj[key]));
}

function generateChangeLog(
  previousSnapshot: AcrDocument | null,
  currentSnapshot: AcrDocument,
  reason?: string
): ChangeLogEntry[] {
  const changes: ChangeLogEntry[] = [];
  
  if (!previousSnapshot) {
    changes.push({
      field: 'document',
      previousValue: null,
      newValue: 'created',
      reason: reason || 'Initial version created'
    });
    return changes;
  }

  if (previousSnapshot.status !== currentSnapshot.status) {
    changes.push({
      field: 'status',
      previousValue: previousSnapshot.status,
      newValue: currentSnapshot.status,
      reason
    });
  }

  if (previousSnapshot.edition !== currentSnapshot.edition) {
    changes.push({
      field: 'edition',
      previousValue: previousSnapshot.edition,
      newValue: currentSnapshot.edition,
      reason
    });
  }

  if (!deepEqual(previousSnapshot.productInfo, currentSnapshot.productInfo)) {
    const prevInfo = previousSnapshot.productInfo;
    const currInfo = currentSnapshot.productInfo;
    
    if (prevInfo.name !== currInfo.name) {
      changes.push({ field: 'productInfo.name', previousValue: prevInfo.name, newValue: currInfo.name, reason });
    }
    if (prevInfo.version !== currInfo.version) {
      changes.push({ field: 'productInfo.version', previousValue: prevInfo.version, newValue: currInfo.version, reason });
    }
    if (prevInfo.vendor !== currInfo.vendor) {
      changes.push({ field: 'productInfo.vendor', previousValue: prevInfo.vendor, newValue: currInfo.vendor, reason });
    }
    if (prevInfo.description !== currInfo.description) {
      changes.push({ field: 'productInfo.description', previousValue: prevInfo.description, newValue: currInfo.description, reason });
    }
    if (prevInfo.contactEmail !== currInfo.contactEmail) {
      changes.push({ field: 'productInfo.contactEmail', previousValue: prevInfo.contactEmail, newValue: currInfo.contactEmail, reason });
    }
    if (!deepEqual(prevInfo.evaluationDate, currInfo.evaluationDate)) {
      changes.push({ field: 'productInfo.evaluationDate', previousValue: prevInfo.evaluationDate, newValue: currInfo.evaluationDate, reason });
    }
  }

  const prevCriteriaMap = new Map(previousSnapshot.criteria.map(c => [c.id, c]));
  const currCriteriaMap = new Map(currentSnapshot.criteria.map(c => [c.id, c]));
  
  for (const [criterionId, currCriterion] of currCriteriaMap) {
    const prevCriterion = prevCriteriaMap.get(criterionId);
    
    if (!prevCriterion) {
      changes.push({
        field: `criteria.${criterionId}`,
        previousValue: null,
        newValue: 'added',
        reason
      });
    } else {
      if (prevCriterion.conformanceLevel !== currCriterion.conformanceLevel) {
        changes.push({
          field: `criteria.${criterionId}.conformanceLevel`,
          previousValue: prevCriterion.conformanceLevel,
          newValue: currCriterion.conformanceLevel,
          reason
        });
      }
      if (prevCriterion.remarks !== currCriterion.remarks) {
        changes.push({
          field: `criteria.${criterionId}.remarks`,
          previousValue: prevCriterion.remarks?.substring(0, 100) + (prevCriterion.remarks?.length > 100 ? '...' : ''),
          newValue: currCriterion.remarks?.substring(0, 100) + (currCriterion.remarks?.length > 100 ? '...' : ''),
          reason
        });
      }
    }
  }

  for (const [criterionId] of prevCriteriaMap) {
    if (!currCriteriaMap.has(criterionId)) {
      changes.push({
        field: `criteria.${criterionId}`,
        previousValue: 'existed',
        newValue: null,
        reason: reason || 'Criterion removed'
      });
    }
  }

  return changes;
}

class AcrVersioningService {
  async createVersion(
    acrId: string,
    snapshot: AcrDocument,
    userId: string,
    reason?: string
  ): Promise<AcrVersion> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const latestVersions = await tx.acrVersion.findMany({
            where: { acrId },
            orderBy: { version: 'desc' },
            take: 1,
            select: { version: true, snapshot: true }
          });

          const newVersionNumber = latestVersions.length > 0
            ? latestVersions[0].version + 1
            : 1;

          const previousSnapshot = latestVersions.length > 0
            ? (latestVersions[0].snapshot as unknown as AcrDocument)
            : null;

          const changeLog = generateChangeLog(previousSnapshot, snapshot, reason);

          const created = await tx.acrVersion.create({
            data: {
              acrId,
              version: newVersionNumber,
              createdBy: userId,
              changeLog: changeLog as unknown as import('@prisma/client').Prisma.InputJsonValue,
              snapshot: snapshot as unknown as import('@prisma/client').Prisma.InputJsonValue
            }
          });

          return {
            id: created.id,
            acrId: created.acrId,
            version: created.version,
            createdAt: created.createdAt,
            createdBy: created.createdBy,
            changeLog,
            snapshot
          };
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        
        // Check for unique constraint violation (P2002)
        const isPrismaError = error && typeof error === 'object' && 'code' in error;
        if (isPrismaError && (error as { code: string }).code === 'P2002') {
          if (attempt < maxRetries) {
            // Wait briefly before retry
            await new Promise(resolve => setTimeout(resolve, 100 * attempt));
            continue;
          }
        }
        
        // For other errors, throw immediately
        throw error;
      }
    }

    throw lastError || new Error('Failed to create version after retries');
  }

  async getVersions(acrId: string): Promise<AcrVersion[]> {
    const versions = await prisma.acrVersion.findMany({
      where: { acrId },
      orderBy: { version: 'desc' }
    });

    return versions.map((v: { id: string; acrId: string; version: number; createdAt: Date; createdBy: string; changeLog: unknown; snapshot: unknown }) => ({
      id: v.id,
      acrId: v.acrId,
      version: v.version,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      changeLog: v.changeLog as unknown as ChangeLogEntry[],
      snapshot: v.snapshot as unknown as AcrDocument
    }));
  }

  async getVersion(acrId: string, version: number): Promise<AcrVersion | null> {
    const found = await prisma.acrVersion.findFirst({
      where: { acrId, version }
    });

    if (!found) return null;

    return {
      id: found.id,
      acrId: found.acrId,
      version: found.version,
      createdAt: found.createdAt,
      createdBy: found.createdBy,
      changeLog: found.changeLog as unknown as ChangeLogEntry[],
      snapshot: found.snapshot as unknown as AcrDocument
    };
  }

  async getLatestVersion(acrId: string): Promise<AcrVersion | null> {
    const found = await prisma.acrVersion.findFirst({
      where: { acrId },
      orderBy: { version: 'desc' }
    });

    if (!found) return null;

    return {
      id: found.id,
      acrId: found.acrId,
      version: found.version,
      createdAt: found.createdAt,
      createdBy: found.createdBy,
      changeLog: found.changeLog as unknown as ChangeLogEntry[],
      snapshot: found.snapshot as unknown as AcrDocument
    };
  }

  async compareVersions(
    acrId: string,
    versionA: number,
    versionB: number
  ): Promise<VersionComparison | null> {
    const [vA, vB] = await Promise.all([
      this.getVersion(acrId, versionA),
      this.getVersion(acrId, versionB)
    ]);

    if (!vA || !vB) return null;

    const changes = generateChangeLog(vA.snapshot, vB.snapshot);

    const criteriaChanged = new Set(
      changes
        .filter(c => c.field.startsWith('criteria.'))
        .map(c => c.field.split('.')[1])
    ).size;

    return {
      acrId,
      versionA,
      versionB,
      changes,
      summary: {
        fieldsChanged: changes.length,
        criteriaChanged,
        statusChanged: vA.snapshot.status !== vB.snapshot.status
      }
    };
  }

  async deleteVersions(acrId: string): Promise<boolean> {
    const result = await prisma.acrVersion.deleteMany({
      where: { acrId }
    });
    return result.count > 0;
  }

  async getVersionCount(acrId: string): Promise<number> {
    return prisma.acrVersion.count({
      where: { acrId }
    });
  }
}

export const acrVersioningService = new AcrVersioningService();

export const createVersion = acrVersioningService.createVersion.bind(acrVersioningService);
export const getVersions = acrVersioningService.getVersions.bind(acrVersioningService);
export const getVersion = acrVersioningService.getVersion.bind(acrVersioningService);
export const getLatestVersion = acrVersioningService.getLatestVersion.bind(acrVersioningService);
export const compareVersions = acrVersioningService.compareVersions.bind(acrVersioningService);
