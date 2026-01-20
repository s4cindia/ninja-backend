import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';

interface Criterion {
  id: string;
  number: string;
  name: string;
  level: 'A' | 'AA' | 'AAA' | 'EU';
  section: string;
  description: string;
  wcagUrl?: string | null;
}

interface Edition {
  code: string;
  name: string;
  description: string;
  totalCount: number;
  standard: string;
  criteriaIds: string[];
}

interface AcrEditionsData {
  editions: Edition[];
  criteria: Criterion[];
}

interface AuditIssue {
  id?: string;
  code: string | null;
  severity: string;
  message: string;
  location?: string | null;
  filePath?: string | null;
  wcagCriteria?: string | null;
  autoFixable?: boolean;
}

interface ManifestEntry {
  id: string;
  href: string;
  mediaType?: string;
  properties?: string;
}

interface AuditResults {
  fileName?: string;
  issues: AuditIssue[];
  manifest?: ManifestEntry[];
}

export class AcrService {
  private editionsData: AcrEditionsData;

  constructor() {
    const dataPath = path.join(__dirname, '../data/acrEditions.json');
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    this.editionsData = JSON.parse(rawData);
  }

  getAllEditions() {
    return this.editionsData.editions.map(edition => ({
      code: edition.code,
      name: edition.name,
      description: edition.description,
      totalCount: edition.totalCount,
      standard: edition.standard,
    }));
  }

  getEditionCriteria(editionCode: string) {
    const edition = this.editionsData.editions.find(e => e.code === editionCode);

    if (!edition) {
      throw new Error(`Edition '${editionCode}' not found`);
    }

    const criteria = edition.criteriaIds
      .map(id => this.editionsData.criteria.find(c => c.id === id))
      .filter(c => c !== undefined) as Criterion[];

    const groupedCriteria = {
      A: criteria.filter(c => c.level === 'A'),
      AA: criteria.filter(c => c.level === 'AA'),
      AAA: criteria.filter(c => c.level === 'AAA'),
      EU: criteria.filter(c => c.level === 'EU'),
    };

    return {
      edition: {
        code: edition.code,
        name: edition.name,
        description: edition.description,
        totalCount: edition.totalCount,
        standard: edition.standard,
      },
      criteriaByLevel: groupedCriteria,
      criteriaCount: {
        A: groupedCriteria.A.length,
        AA: groupedCriteria.AA.length,
        AAA: groupedCriteria.AAA.length,
        EU: groupedCriteria.EU.length,
        total: criteria.length,
      },
    };
  }

  getCriterionById(criterionId: string) {
    const criterion = this.editionsData.criteria.find(c => c.id === criterionId);

    if (!criterion) {
      throw new Error(`Criterion '${criterionId}' not found`);
    }

    return criterion;
  }

  async createAcrAnalysis(
    userId: string,
    tenantId: string,
    jobId: string,
    edition: string,
    documentTitle?: string
  ) {
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenantId,
        userId,
      },
    });

    if (!job) {
      throw new Error('Job not found or access denied');
    }

    const auditResults = await this.fetchEpubAuditResults(jobId, tenantId, userId);

    const editionData = this.editionsData.editions.find(e => e.code === edition);
    if (!editionData) {
      throw new Error(`Invalid edition: ${edition}`);
    }

    const acrJob = await prisma.acrJob.create({
      data: {
        jobId,
        tenantId,
        userId,
        edition,
        documentTitle: documentTitle || auditResults.fileName || 'Untitled Document',
        status: 'in_progress',
      },
    });

    const criteriaReviews = [];

    for (const criterionId of editionData.criteriaIds) {
      const criterion = this.editionsData.criteria.find(c => c.id === criterionId);
      if (!criterion) continue;

      const analysis = this.analyzeCriterion(criterion, auditResults);

      const review = await prisma.acrCriterionReview.create({
        data: {
          acrJobId: acrJob.id,
          criterionId: criterion.id,
          criterionNumber: criterion.number,
          criterionName: criterion.name,
          level: criterion.level,
          confidence: analysis.confidence,
          aiStatus: analysis.status,
          evidence: analysis.evidence || undefined,
        },
      });

      criteriaReviews.push(review);
    }

    // Create initial version snapshot
    try {
      const { acrVersioningService } = await import('./acr/acr-versioning.service');
      
      // Normalize evidence to string array
      const normalizeEvidence = (evidence: unknown): string[] => {
        if (!evidence) return [];
        if (Array.isArray(evidence)) {
          return evidence.filter((e): e is string => typeof e === 'string');
        }
        if (typeof evidence === 'string') return [evidence];
        return [];
      };
      
      const initialSnapshot = {
        id: acrJob.id,
        edition: edition as 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT',
        productInfo: {
          name: documentTitle || auditResults.fileName || 'Untitled Document',
          version: '1.0',
          description: '',
          vendor: '',
          contactEmail: '',
          evaluationDate: new Date()
        },
        evaluationMethods: [{
          type: 'automated' as const,
          tools: ['Ninja ACR Analyzer'],
          description: 'Initial automated accessibility analysis'
        }],
        criteria: criteriaReviews.map(r => ({
          id: r.id,
          criterionId: r.criterionId,
          name: r.criterionName,
          level: (r.level || 'A') as 'A' | 'AA' | 'AAA',
          conformanceLevel: 'Not Applicable' as const,
          remarks: normalizeEvidence(r.evidence).join('. ') || '',
        })),
        generatedAt: new Date(),
        version: 1,
        status: 'draft' as const
      };
      await acrVersioningService.createVersion(acrJob.id, initialSnapshot, userId, 'Initial ACR analysis created');
    } catch (versionError) {
      // Log but don't fail the ACR creation
      console.error('Failed to create initial version:', versionError);
    }

    return {
      acrJob,
      criteriaCount: criteriaReviews.length,
    };
  }

  async getAcrAnalysis(acrJobId: string, userId: string, tenantId: string) {
    const acrJob = await prisma.acrJob.findFirst({
      where: {
        OR: [
          { id: acrJobId },
          { jobId: acrJobId }
        ],
        userId,
        tenantId,
      },
      include: {
        criteria: {
          orderBy: {
            criterionNumber: 'asc',
          },
        },
      },
    });

    if (!acrJob) {
      throw new Error('ACR job not found');
    }

    const criteria = acrJob.criteria.map(c => ({
      id: c.id,
      criterionId: c.criterionId,
      number: c.criterionNumber,
      name: c.criterionName,
      level: c.level,
      confidence: c.confidence,
      status: c.aiStatus,
      evidence: c.evidence as any,
      conformanceLevel: c.conformanceLevel,
      remarks: c.reviewerNotes,
      reviewedAt: c.reviewedAt,
    }));

    const stats = {
      total: criteria.length,
      reviewed: criteria.filter(c => c.conformanceLevel).length,
      byStatus: {
        fail: criteria.filter(c => c.status === 'fail').length,
        needs_verification: criteria.filter(c => c.status === 'needs_verification').length,
        likely_na: criteria.filter(c => c.status === 'likely_na').length,
        pass: criteria.filter(c => c.status === 'pass').length,
      },
      byConformance: {
        supports: criteria.filter(c => c.conformanceLevel === 'supports').length,
        partially_supports: criteria.filter(c => c.conformanceLevel === 'partially_supports').length,
        does_not_support: criteria.filter(c => c.conformanceLevel === 'does_not_support').length,
        not_applicable: criteria.filter(c => c.conformanceLevel === 'not_applicable').length,
      },
    };

    return {
      acrJob: {
        id: acrJob.id,
        jobId: acrJob.jobId,
        edition: acrJob.edition,
        status: acrJob.status,
        documentTitle: acrJob.documentTitle,
        createdAt: acrJob.createdAt,
      },
      criteria,
      stats,
    };
  }

  async getAcrAnalysisByJobId(jobId: string, userId: string, tenantId: string) {
    const acrJob = await prisma.acrJob.findFirst({
      where: {
        jobId,
        userId,
        tenantId,
      },
      include: {
        criteria: {
          orderBy: {
            criterionNumber: 'asc',
          },
        },
      },
    });

    if (!acrJob) {
      return null;
    }

    const criteria = acrJob.criteria.map(c => ({
      id: c.id,
      criterionId: c.criterionId,
      number: c.criterionNumber,
      name: c.criterionName,
      level: c.level,
      confidence: c.confidence,
      status: c.aiStatus,
      evidence: c.evidence as any,
      conformanceLevel: c.conformanceLevel,
      remarks: c.reviewerNotes,
      reviewedAt: c.reviewedAt,
    }));

    const stats = {
      total: criteria.length,
      reviewed: criteria.filter(c => c.conformanceLevel).length,
      byStatus: {
        fail: criteria.filter(c => c.status === 'fail').length,
        needs_verification: criteria.filter(c => c.status === 'needs_verification').length,
        likely_na: criteria.filter(c => c.status === 'likely_na').length,
        pass: criteria.filter(c => c.status === 'pass').length,
      },
      byConformance: {
        supports: criteria.filter(c => c.conformanceLevel === 'supports').length,
        partially_supports: criteria.filter(c => c.conformanceLevel === 'partially_supports').length,
        does_not_support: criteria.filter(c => c.conformanceLevel === 'does_not_support').length,
        not_applicable: criteria.filter(c => c.conformanceLevel === 'not_applicable').length,
      },
    };

    return {
      acrJob: {
        id: acrJob.id,
        jobId: acrJob.jobId,
        edition: acrJob.edition,
        status: acrJob.status,
        documentTitle: acrJob.documentTitle,
        createdAt: acrJob.createdAt,
      },
      criteria,
      stats,
    };
  }

  async saveCriterionReview(
    acrJobId: string,
    criterionId: string,
    userId: string,
    tenantId: string,
    reviewData: {
      conformanceLevel?: 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable';
      remarks?: string;
    }
  ) {
    const acrJob = await prisma.acrJob.findFirst({
      where: { 
        OR: [{ id: acrJobId }, { jobId: acrJobId }],
        userId, 
        tenantId 
      },
    });

    if (!acrJob) {
      throw new Error('ACR job not found or access denied');
    }

    const criterion = await prisma.acrCriterionReview.findFirst({
      where: {
        acrJobId: acrJob.id,
        OR: [
          { id: criterionId },
          { criterionId: criterionId }
        ]
      }
    });

    if (!criterion) {
      throw new Error('Criterion not found in ACR job');
    }

    const updateData: Record<string, unknown> = {
      reviewedAt: new Date(),
      reviewedBy: userId,
    };
    
    if (reviewData.conformanceLevel !== undefined) {
      updateData.conformanceLevel = reviewData.conformanceLevel;
    }
    
    if (reviewData.remarks !== undefined) {
      updateData.reviewerNotes = reviewData.remarks;
    }

    await prisma.acrCriterionReview.update({
      where: { id: criterion.id },
      data: updateData,
    });

    const totalCriteria = await prisma.acrCriterionReview.count({
      where: { acrJobId: acrJob.id },
    });

    const reviewedCriteria = await prisma.acrCriterionReview.count({
      where: {
        acrJobId: acrJob.id,
        conformanceLevel: { not: null },
      },
    });

    if (totalCriteria === reviewedCriteria) {
      await prisma.acrJob.update({
        where: { id: acrJob.id },
        data: { status: 'completed' },
      });
    }

    return {
      success: true,
      progress: {
        reviewed: reviewedCriteria,
        total: totalCriteria,
        percentage: totalCriteria === 0 ? 0 : Math.round((reviewedCriteria / totalCriteria) * 100),
      },
    };
  }

  async saveBulkReviews(
    acrJobId: string,
    userId: string,
    tenantId: string,
    reviews: Array<{
      criterionId: string;
      conformanceLevel: string;
      remarks?: string;
    }>
  ) {
    const validLevels = ['supports', 'partially_supports', 'does_not_support', 'not_applicable'];
    const invalidReviews = reviews.filter(r => !validLevels.includes(r.conformanceLevel));
    if (invalidReviews.length > 0) {
      const invalidLevels = [...new Set(invalidReviews.map(r => r.conformanceLevel))];
      throw new Error(`Invalid conformance levels: ${invalidLevels.join(', ')}. Must be one of: ${validLevels.join(', ')}`);
    }

    const acrJob = await prisma.acrJob.findFirst({
      where: { 
        OR: [{ id: acrJobId }, { jobId: acrJobId }],
        userId, 
        tenantId 
      },
    });

    if (!acrJob) {
      throw new Error('ACR job not found or access denied');
    }

    const results = await prisma.$transaction(
      reviews.map(review =>
        prisma.acrCriterionReview.updateMany({
          where: {
            acrJobId: acrJob.id,
            criterionId: review.criterionId,
          },
          data: {
            conformanceLevel: review.conformanceLevel,
            reviewerNotes: review.remarks || null,
            reviewedAt: new Date(),
            reviewedBy: userId,
          },
        })
      )
    );

    const totalCriteria = await prisma.acrCriterionReview.count({
      where: { acrJobId: acrJob.id },
    });

    const reviewedCriteria = await prisma.acrCriterionReview.count({
      where: {
        acrJobId: acrJob.id,
        conformanceLevel: { not: null },
      },
    });

    if (totalCriteria === reviewedCriteria) {
      await prisma.acrJob.update({
        where: { id: acrJob.id },
        data: { status: 'completed' },
      });
    }

    return {
      success: true,
      updated: results.reduce((sum, r) => sum + r.count, 0),
      progress: {
        reviewed: reviewedCriteria,
        total: totalCriteria,
        percentage: totalCriteria === 0 ? 0 : Math.round((reviewedCriteria / totalCriteria) * 100),
      },
    };
  }

  async getCriterionDetails(acrJobId: string, criterionId: string, userId: string, tenantId: string) {
    const acrJob = await prisma.acrJob.findFirst({
      where: { 
        OR: [{ id: acrJobId }, { jobId: acrJobId }],
        userId, 
        tenantId 
      },
    });

    if (!acrJob) {
      throw new Error('ACR job not found or access denied');
    }

    const criterion = await prisma.acrCriterionReview.findFirst({
      where: {
        acrJobId: acrJob.id,
        criterionId,
      },
    });

    if (!criterion) {
      throw new Error('Criterion not found');
    }

    const criterionData = this.editionsData.criteria.find(c => c.id === criterionId);

    return {
      id: criterion.id,
      criterionId: criterion.criterionId,
      number: criterion.criterionNumber,
      name: criterion.criterionName,
      level: criterion.level,
      confidence: criterion.confidence,
      status: criterion.aiStatus,
      evidence: criterion.evidence,
      conformanceLevel: criterion.conformanceLevel,
      remarks: criterion.reviewerNotes,
      reviewedAt: criterion.reviewedAt,
      reviewedBy: criterion.reviewedBy,
      description: criterionData?.description,
      wcagUrl: criterionData?.wcagUrl,
      section: criterionData?.section,
    };
  }

  private analyzeCriterion(criterion: Criterion, auditResults: AuditResults) {
    const relatedIssues = this.findRelatedAuditIssues(criterion, auditResults.issues || []);

    if (relatedIssues.length > 0) {
      return {
        confidence: 0,
        status: 'fail',
        evidence: {
          source: 'epub_audit',
          description: this.generateEvidenceDescription(relatedIssues),
          auditIssues: relatedIssues.map(issue => ({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            affectedFiles: issue.filePath ? [issue.filePath] : [],
            issueCount: 1,
          })),
          affectedFiles: relatedIssues.map((i: any) => i.filePath).filter(Boolean),
          issueCount: relatedIssues.length,
        },
      };
    }

    const isLikelyNA = this.isLikelyNotApplicable(criterion, auditResults);

    return {
      confidence: 0,
      status: isLikelyNA ? 'likely_na' : 'needs_verification',
      evidence: null,
    };
  }

  private findRelatedAuditIssues(criterion: Criterion, auditIssues: any[]) {
    const related = [];

    for (const issue of auditIssues) {
      if (this.isIssueRelatedToCriterion(issue, criterion)) {
        related.push(issue);
      }
    }

    return related;
  }

  private isIssueRelatedToCriterion(issue: any, criterion: Criterion) {
    const issueCode = issue.code?.toUpperCase() || '';
    const criterionNumber = criterion.number;

    const mappings: Record<string, string[]> = {
      'EPUB-STRUCT-002': ['1.3.1', '4.1.2'],
      'RSC-001': ['4.1.1'],
      'EPUB-META': ['1.3.1', '4.1.2'],
      'IMAGE-ALT': ['1.1.1'],
      'EPUB-IMG-001': ['1.1.1'],
      'HEADING': ['1.3.1', '2.4.6'],
      'EPUB-STRUCT-003': ['1.3.1', '2.4.6'],
      'TABLE': ['1.3.1'],
      'LANGUAGE': ['3.1.1', '3.1.2'],
      'EPUB-SEM-001': ['3.1.1'],
      'EPUB-META-001': ['3.1.1'],
      'CONTRAST': ['1.4.3'],
      'LANDMARK': ['2.4.1'],
      'EPUB-STRUCT-004': ['2.4.1'],
      'EPUB-NAV-001': ['2.4.1'],
    };

    for (const [pattern, criteria] of Object.entries(mappings)) {
      if (issueCode.includes(pattern)) {
        return criteria.includes(criterionNumber);
      }
    }

    return false;
  }

  private generateEvidenceDescription(issues: any[]): string {
    if (issues.length === 1) {
      return issues[0].message;
    }

    const issuesByCode = issues.reduce((acc, issue) => {
      acc[issue.code] = (acc[issue.code] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const parts = Object.entries(issuesByCode).map(
      ([code, count]) => `${count as number} ${code} issue${(count as number) > 1 ? 's' : ''}`
    );

    return parts.join(', ');
  }

  private isLikelyNotApplicable(criterion: Criterion, auditResults: AuditResults): boolean {
    const criterionNumber = criterion.number;

    if (['1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.2.6', '1.2.7', '1.2.8', '1.2.9'].includes(criterionNumber)) {
      const hasMedia = auditResults.manifest?.some((item: any) =>
        item.mediaType?.includes('audio') || item.mediaType?.includes('video')
      );
      return !hasMedia;
    }

    if (['3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.5', '3.3.6'].includes(criterionNumber)) {
      return true;
    }

    if (['2.2.1', '2.2.2', '2.2.3', '2.2.4', '2.2.5', '2.2.6'].includes(criterionNumber)) {
      return true;
    }

    return false;
  }

  private async fetchEpubAuditResults(jobId: string, tenantId: string, userId: string): Promise<AuditResults> {
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenantId,
        userId,
      },
      include: {
        validationResults: {
          include: {
            issues: true,
          },
        },
      },
    });

    if (!job) {
      return {
        fileName: 'Unknown Document',
        issues: [],
        manifest: [],
      };
    }

    const allIssues = job.validationResults.flatMap(vr =>
      vr.issues.map(issue => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.description,
        filePath: issue.filePath,
        wcagCriteria: issue.wcagCriteria,
      }))
    );

    const input = job.input as any;
    const fileName = input?.originalName || input?.fileName || 'Unknown Document';

    return {
      fileName,
      issues: allIssues,
      manifest: [],
    };
  }

  async resolveAcrJob(jobId: string) {
    return prisma.acrJob.findFirst({
      where: {
        OR: [
          { id: jobId },
          { jobId: jobId },
        ],
      },
    });
  }

  async updateAcrJobStatus(acrJobId: string, status: string) {
    return prisma.acrJob.update({
      where: { id: acrJobId },
      data: {
        status,
        updatedAt: new Date(),
      },
    });
  }
}

export const acrService = new AcrService();
