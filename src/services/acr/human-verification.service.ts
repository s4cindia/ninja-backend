import { v4 as uuidv4 } from 'uuid';
import { ConfidenceLevel, confidenceAnalyzerService } from './confidence-analyzer.service';
import prisma from '../../lib/prisma';

export type VerificationStatus =
  | 'PENDING'
  | 'VERIFIED_PASS'
  | 'VERIFIED_FAIL'
  | 'VERIFIED_PARTIAL'
  | 'DEFERRED';

export interface VerificationRecord {
  id: string;
  validationItemId: string;
  status: VerificationStatus;
  verifiedBy: string;
  verifiedAt: Date;
  method: string;
  notes: string;
  previousStatus?: VerificationStatus;
}

export interface RelatedIssue {
  code: string;
  message: string;
  severity: string;
  location?: string;
  status?: string;
}

export interface VerificationQueueItem {
  id: string;
  criterionId: string;
  wcagCriterion: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidenceLevel: ConfidenceLevel;
  automatedResult: string;
  status: VerificationStatus;
  verificationHistory: VerificationRecord[];
  relatedIssues?: RelatedIssue[];
  fixedIssues?: RelatedIssue[];
}

export interface VerificationQueue {
  jobId: string;
  totalItems: number;
  pendingItems: number;
  verifiedItems: number;
  deferredItems: number;
  canFinalize: boolean;
  blockers: string[];
  items: VerificationQueueItem[];
}

export interface SubmitVerificationInput {
  status: VerificationStatus;
  method: string;
  notes: string;
}

export interface CanFinalizeResult {
  canFinalize: boolean;
  blockers: string[];
  verifiedCount: number;
  totalRequired: number;
}

// TODO: Migrate to database persistence for production (currently uses Job.output as backup)
const verificationStore = new Map<string, VerificationQueueItem[]>();
const recordStore = new Map<string, VerificationRecord[]>();

const SEVERITY_ORDER: Record<string, number> = {
  'critical': 0,
  'serious': 1,
  'moderate': 2,
  'minor': 3
};

const CRITERIA_SEVERITY: Record<string, 'critical' | 'serious' | 'moderate' | 'minor'> = {
  '1.1.1': 'critical',
  '1.3.1': 'critical',
  '1.4.3': 'serious',
  '2.1.1': 'critical',
  '2.4.1': 'serious',
  '2.4.6': 'moderate',
  '3.1.1': 'moderate',
  '3.1.2': 'minor',
  '3.3.2': 'moderate',
  '4.1.1': 'serious',
  '4.1.2': 'serious'
};

class HumanVerificationService {
  async initializeQueue(jobId: string, criteriaIds: string[]): Promise<VerificationQueue> {
    const items: VerificationQueueItem[] = criteriaIds.map(criterionId => {
      const confidence = confidenceAnalyzerService.analyzeConfidence(criterionId);
      const severity = CRITERIA_SEVERITY[criterionId] || 'moderate';
      
      return {
        id: uuidv4(),
        criterionId,
        wcagCriterion: confidence.wcagCriterion,
        severity,
        confidenceLevel: confidence.confidenceLevel,
        automatedResult: 'pending',
        status: 'PENDING',
        verificationHistory: []
      };
    });

    items.sort((a, b) => {
      const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (severityDiff !== 0) return severityDiff;
      
      const confidenceOrder: Record<ConfidenceLevel, number> = {
        'MANUAL_REQUIRED': 0,
        'LOW': 1,
        'MEDIUM': 2,
        'HIGH': 3
      };
      return confidenceOrder[a.confidenceLevel] - confidenceOrder[b.confidenceLevel];
    });

    verificationStore.set(jobId, items);
    
    return await this.getQueue(jobId);
  }

  async getQueue(jobId: string): Promise<VerificationQueue> {
    let items = verificationStore.get(jobId);
    
    if (!items) {
      const defaultCriteria = [
        '1.1.1', '1.3.1', '1.4.3', '2.1.1', '2.4.1', '2.4.6',
        '3.1.1', '3.1.2', '3.3.2', '4.1.1', '4.1.2'
      ];
      return this.initializeQueue(jobId, defaultCriteria);
    }

    const pendingItems = items.filter(i => i.status === 'PENDING').length;
    const verifiedItems = items.filter(i => 
      i.status === 'VERIFIED_PASS' || 
      i.status === 'VERIFIED_FAIL' || 
      i.status === 'VERIFIED_PARTIAL'
    ).length;
    const deferredItems = items.filter(i => i.status === 'DEFERRED').length;

    const finalizeCheck = await this.canFinalizeAcr(jobId);

    return {
      jobId,
      totalItems: items.length,
      pendingItems,
      verifiedItems,
      deferredItems,
      canFinalize: finalizeCheck.canFinalize,
      blockers: finalizeCheck.blockers,
      items
    };
  }

  async getQueueFromJob(jobId: string): Promise<VerificationQueue> {
    const cachedItems = verificationStore.get(jobId);
    if (cachedItems) {
      return await this.getQueue(jobId);
    }

    try {
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        include: {
          validationResults: {
            include: {
              issues: true
            }
          }
        }
      });

      if (!job) {
        return await this.getQueue(jobId);
      }

      const existingOutput = job.output as { verificationQueue?: VerificationQueueItem[]; auditLog?: VerificationRecord[] } | null;
      if (existingOutput?.verificationQueue && existingOutput.verificationQueue.length > 0) {
        const items = existingOutput.verificationQueue.map(item => ({
          ...item,
          verificationHistory: item.verificationHistory || []
        }));
        verificationStore.set(jobId, items);
        if (existingOutput.auditLog) {
          recordStore.set(jobId, existingOutput.auditLog.map(r => ({
            ...r,
            verifiedAt: new Date(r.verifiedAt)
          })));
        }
        return await this.getQueue(jobId);
      }

      const criteriaSet = new Set<string>();
      const criteriaResults = new Map<string, { passed: boolean; automatedResult: string; resultId: string }>();

      for (const result of job.validationResults) {
        const checkTypeToCriteria: Record<string, string> = {
          'alt-text': '1.1.1',
          'color-contrast': '1.4.3',
          'heading-structure': '1.3.1',
          'language': '3.1.1',
          'reading-order': '1.3.2',
          'table-structure': '1.3.1',
          'parsing': '4.1.1'
        };

        const criterionId = checkTypeToCriteria[result.checkType];
        if (criterionId) {
          criteriaSet.add(criterionId);
          criteriaResults.set(criterionId, {
            passed: result.passed,
            automatedResult: result.passed ? 'pass' : 'fail',
            resultId: result.id
          });
        }

        for (const issue of result.issues) {
          if (issue.wcagCriteria) {
            criteriaSet.add(issue.wcagCriteria);
            criteriaResults.set(issue.wcagCriteria, {
              passed: false,
              automatedResult: 'fail',
              resultId: result.id
            });
          }
        }
      }

      if (criteriaSet.size === 0) {
        return await this.getQueue(jobId);
      }

      const items: VerificationQueueItem[] = Array.from(criteriaSet).map(criterionId => {
        const confidence = confidenceAnalyzerService.analyzeConfidence(criterionId);
        const severity = CRITERIA_SEVERITY[criterionId] || 'moderate';
        const resultInfo = criteriaResults.get(criterionId);

        return {
          id: resultInfo?.resultId ? `${resultInfo.resultId}_${criterionId}` : uuidv4(),
          criterionId,
          wcagCriterion: confidence.wcagCriterion,
          severity,
          confidenceLevel: confidence.confidenceLevel,
          automatedResult: resultInfo?.automatedResult || 'pending',
          status: 'PENDING' as VerificationStatus,
          verificationHistory: []
        };
      });

      items.sort((a, b) => {
        const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (severityDiff !== 0) return severityDiff;

        const confidenceOrder: Record<ConfidenceLevel, number> = {
          'MANUAL_REQUIRED': 0,
          'LOW': 1,
          'MEDIUM': 2,
          'HIGH': 3
        };
        return confidenceOrder[a.confidenceLevel] - confidenceOrder[b.confidenceLevel];
      });

      verificationStore.set(jobId, items);

      await this.persistToJob(jobId);

      return await this.getQueue(jobId);
    } catch (error) {
      console.error(`[HumanVerification] getQueueFromJob error:`, error);
      return await this.getQueue(jobId);
    }
  }

  private async persistToJob(jobId: string): Promise<void> {
    const items = verificationStore.get(jobId);
    const records = recordStore.get(jobId) || [];

    if (!items) return;

    try {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) return;

      const existingOutput = (job.output as Record<string, unknown>) || {};

      const outputData = JSON.parse(JSON.stringify({
        ...existingOutput,
        verificationQueue: items,
        auditLog: records
      }));

      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: outputData
        }
      });
    } catch (error) {
      console.error(`[HumanVerification] Persistence failed for job ${jobId}:`, error);
    }
  }

  getQueueItem(itemId: string): VerificationQueueItem | undefined {
    for (const items of verificationStore.values()) {
      const item = items.find(i => i.id === itemId);
      if (item) return item;
    }
    return undefined;
  }

  findJobIdForItem(itemId: string): string | undefined {
    for (const [jobId, items] of verificationStore) {
      if (items.some(i => i.id === itemId)) {
        return jobId;
      }
    }
    return undefined;
  }

  // TODO: POST-MVP - Add rollback logic if persistToJob fails
  // TODO: POST-MVP - Add mutex/locking for concurrent verification submissions
  async submitVerification(
    itemId: string,
    verification: SubmitVerificationInput,
    userId: string
  ): Promise<VerificationRecord | null> {
    let targetItem: VerificationQueueItem | undefined;
    let targetJobId: string | undefined;

    for (const [jobId, items] of verificationStore) {
      const item = items.find(i => i.id === itemId);
      if (item) {
        targetItem = item;
        targetJobId = jobId;
        break;
      }
    }

    if (!targetItem || !targetJobId) {
      return null;
    }

    const record: VerificationRecord = {
      id: uuidv4(),
      validationItemId: itemId,
      status: verification.status,
      verifiedBy: userId,
      verifiedAt: new Date(),
      method: verification.method,
      notes: verification.notes,
      previousStatus: targetItem.status
    };

    targetItem.status = verification.status;
    targetItem.verificationHistory.push(record);

    const existingRecords = recordStore.get(targetJobId) || [];
    existingRecords.push(record);
    recordStore.set(targetJobId, existingRecords);

    await this.persistToJob(targetJobId);

    return record;
  }

  async canFinalizeAcr(jobId: string): Promise<CanFinalizeResult> {
    // First check if there are database-stored criterion reviews (from ACR Review & Edit page)
    try {
      const acrJob = await prisma.acrJob.findFirst({
        where: { 
          OR: [
            { id: jobId },
            { jobId: jobId }
          ]
        },
        include: {
          criteria: true
        }
      });

      if (acrJob && acrJob.criteria.length > 0) {
        // Use database-stored reviews for finalization check
        const reviews = acrJob.criteria;
        const blockers: string[] = [];
        let verifiedCount = 0;

        // Check critical and serious criteria for human-reviewed status
        for (const review of reviews) {
          const severity = CRITERIA_SEVERITY[review.criterionId] || 'moderate';
          const isCriticalOrSerious = severity === 'critical' || severity === 'serious';
          
          if (isCriticalOrSerious) {
            // Consider reviewed if it has a conformance level AND was reviewed by someone
            if (review.conformanceLevel && review.reviewedBy) {
              verifiedCount++;
            } else if (review.conformanceLevel) {
              // Has conformance but no reviewer - still count as verified for now
              verifiedCount++;
            } else {
              blockers.push(`${review.criterionId} - ${severity} severity, requires verification`);
            }
          }
        }

        const requiredCount = reviews.filter((r: { criterionId: string }) => {
          const severity = CRITERIA_SEVERITY[r.criterionId] || 'moderate';
          return severity === 'critical' || severity === 'serious';
        }).length;

        return {
          canFinalize: blockers.length === 0,
          blockers,
          verifiedCount,
          totalRequired: requiredCount
        };
      }
    } catch (dbError) {
      // Fall through to in-memory check if database check fails
      console.warn('[canFinalizeAcr] Database check failed, using in-memory store:', dbError);
    }

    // Fallback to in-memory verification store
    let items = verificationStore.get(jobId);
    
    if (!items) {
      await this.getQueueFromJob(jobId);
      items = verificationStore.get(jobId);
    }
    
    if (!items) {
      return {
        canFinalize: false,
        blockers: ['No verification queue found for this job'],
        verifiedCount: 0,
        totalRequired: 0
      };
    }

    const criticalItems = items.filter(i => i.severity === 'critical');
    const seriousItems = items.filter(i => i.severity === 'serious');
    const manualRequiredItems = items.filter(i => i.confidenceLevel === 'MANUAL_REQUIRED');
    const lowConfidenceItems = items.filter(i => i.confidenceLevel === 'LOW');

    const requiredItems = [...new Set([
      ...criticalItems,
      ...seriousItems,
      ...manualRequiredItems,
      ...lowConfidenceItems
    ])];

    const blockers: string[] = [];
    let verifiedCount = 0;

    for (const item of requiredItems) {
      if (item.status === 'VERIFIED_PASS' || 
          item.status === 'VERIFIED_FAIL' || 
          item.status === 'VERIFIED_PARTIAL') {
        verifiedCount++;
      } else if (item.status === 'PENDING') {
        blockers.push(`${item.wcagCriterion} (${item.criterionId}) - ${item.severity} severity, requires verification`);
      } else if (item.status === 'DEFERRED') {
        blockers.push(`${item.wcagCriterion} (${item.criterionId}) - deferred, must be resolved before finalization`);
      }
    }

    return {
      canFinalize: blockers.length === 0,
      blockers,
      verifiedCount,
      totalRequired: requiredItems.length
    };
  }

  async getAuditLog(jobId: string): Promise<VerificationRecord[]> {
    let records = recordStore.get(jobId);
    
    if (!records) {
      await this.getQueueFromJob(jobId);
      records = recordStore.get(jobId) || [];
    }
    
    return records.sort((a, b) => 
      new Date(b.verifiedAt).getTime() - new Date(a.verifiedAt).getTime()
    );
  }

  getVerificationMethods(): string[] {
    return [
      'NVDA 2024.1',
      'JAWS 2024',
      'VoiceOver (macOS)',
      'VoiceOver (iOS)',
      'TalkBack (Android)',
      'Narrator (Windows)',
      'Manual Keyboard Testing',
      'Visual Inspection',
      'Color Contrast Analyzer',
      'Document Review',
      'Expert Assessment'
    ];
  }

  async bulkVerify(
    itemIds: string[],
    verification: SubmitVerificationInput,
    userId: string
  ): Promise<VerificationRecord[]> {
    const records: VerificationRecord[] = [];
    
    for (const itemId of itemIds) {
      const record = await this.submitVerification(itemId, verification, userId);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  filterQueue(
    jobId: string,
    filters: {
      severity?: ('critical' | 'serious' | 'moderate' | 'minor')[];
      confidenceLevel?: ConfidenceLevel[];
      status?: VerificationStatus[];
    }
  ): VerificationQueueItem[] {
    const items = verificationStore.get(jobId) || [];
    
    return items.filter(item => {
      if (filters.severity && !filters.severity.includes(item.severity)) {
        return false;
      }
      if (filters.confidenceLevel && !filters.confidenceLevel.includes(item.confidenceLevel)) {
        return false;
      }
      if (filters.status && !filters.status.includes(item.status)) {
        return false;
      }
      return true;
    });
  }
}

export const humanVerificationService = new HumanVerificationService();
