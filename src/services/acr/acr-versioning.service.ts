import { v4 as uuidv4 } from 'uuid';
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

// TODO: Migrate to database persistence for production (in-memory loses data on restart)
const versionStore = new Map<string, AcrVersion[]>();

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  
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

async function createVersion(
  acrId: string,
  userId: string,
  snapshot: AcrDocument,
  reason?: string
): Promise<AcrVersion> {
  const existingVersions = versionStore.get(acrId) || [];
  const previousVersion = existingVersions.length > 0 
    ? existingVersions[existingVersions.length - 1] 
    : null;
  
  const newVersionNumber = previousVersion ? previousVersion.version + 1 : 1;
  
  const changeLog = generateChangeLog(
    previousVersion?.snapshot || null,
    snapshot,
    reason
  );

  const snapshotWithVersion: AcrDocument = {
    ...snapshot,
    version: newVersionNumber
  };

  const version: AcrVersion = {
    id: uuidv4(),
    acrId,
    version: newVersionNumber,
    createdAt: new Date(),
    createdBy: userId,
    changeLog,
    snapshot: snapshotWithVersion
  };

  existingVersions.push(version);
  versionStore.set(acrId, existingVersions);

  return version;
}

async function getVersions(acrId: string): Promise<AcrVersion[]> {
  return versionStore.get(acrId) || [];
}

async function getVersion(acrId: string, versionNumber: number): Promise<AcrVersion | null> {
  const versions = versionStore.get(acrId) || [];
  return versions.find(v => v.version === versionNumber) || null;
}

async function getLatestVersion(acrId: string): Promise<AcrVersion | null> {
  const versions = versionStore.get(acrId) || [];
  if (versions.length === 0) return null;
  return versions[versions.length - 1];
}

async function compareVersions(
  acrId: string,
  versionA: number,
  versionB: number
): Promise<VersionComparison | null> {
  const versions = versionStore.get(acrId) || [];
  
  const versionAData = versions.find(v => v.version === versionA);
  const versionBData = versions.find(v => v.version === versionB);
  
  if (!versionAData || !versionBData) {
    return null;
  }

  const changes = generateChangeLog(versionAData.snapshot, versionBData.snapshot);

  const criteriaChanges = changes.filter(c => c.field.startsWith('criteria.'));
  const statusChanged = changes.some(c => c.field === 'status');

  return {
    acrId,
    versionA,
    versionB,
    changes,
    summary: {
      fieldsChanged: changes.length,
      criteriaChanged: new Set(criteriaChanges.map(c => c.field.split('.')[1])).size,
      statusChanged
    }
  };
}

async function deleteVersions(acrId: string): Promise<boolean> {
  return versionStore.delete(acrId);
}

function getVersionCount(acrId: string): number {
  const versions = versionStore.get(acrId) || [];
  return versions.length;
}

export const acrVersioningService = {
  createVersion,
  getVersions,
  getVersion,
  getLatestVersion,
  compareVersions,
  deleteVersions,
  getVersionCount
};

export { createVersion, getVersions, getVersion, getLatestVersion, compareVersions };
