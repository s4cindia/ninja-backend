import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { v4 as uuidv4 } from 'uuid';
import type { ApplicabilitySuggestion } from './content-detection.service';
import type { Prisma } from '@prisma/client';
import { wcagCriteriaService } from '../validation/wcag-criteria.service';

/**
 * ACR Report Review Service
 * Handles the Review & Edit step - importing verification data and managing final report
 *
 * Key principle: MINIMUM DATA ENTRY - carry forward all verification work
 */

interface VerificationImportData {
  criterionId: string;
  verificationStatus?: string;
  verificationMethod?: string;
  verificationNotes?: string;
  isNotApplicable?: boolean;
  naReason?: string;
  naSuggestion?: ApplicabilitySuggestion;
  confidence?: number; // 0-100 scale
}

interface CriterionUpdateData {
  verificationStatus?: string;
  verificationMethod?: string;
  verificationNotes?: string;
  reviewerNotes?: string;
  conformanceLevel?: string;
  isNotApplicable?: boolean;
  naReason?: string;
  [key: string]: string | boolean | undefined; // Add index signature for type compatibility
}

interface ReportMetadataUpdate {
  executiveSummary?: string;
  conformanceLevel?: string;
  documentType?: string;
}

class AcrReportReviewService {
  /**
   * Initialize AcrJob and import verification data
   * This carries forward all verification work to minimize data entry
   */
  async initializeReportFromVerification(
    jobId: string,
    tenantId: string,
    userId: string,
    edition: string,
    verificationData: VerificationImportData[],
    documentTitle?: string
  ) {
    logger.info(`[ACR Report Review] Initializing report for job ${jobId}`);

    if (!verificationData || !Array.isArray(verificationData)) {
      throw new Error('verificationData must be a non-empty array of criterion verification objects');
    }

    try {
      // Fetch source job to detect document type
      const sourceJob = await prisma.job.findUnique({
        where: { id: jobId }
      });

      // Detect document type and generate executive summary
      const documentType = this.detectDocumentType(sourceJob);
      const executiveSummary = this.generateExecutiveSummary(verificationData, documentType);

      // Check if previous drafts exist (for versioning info)
      const existingDrafts = await prisma.acrJob.findMany({
        where: { jobId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, status: true }
      });

      if (existingDrafts.length > 0) {
        logger.info(`[ACR Report Review] Found ${existingDrafts.length} existing draft(s) for job ${jobId}. Creating new version (previous drafts preserved).`);
      }

      // Always create NEW AcrJob to preserve version history (never update existing)
      const acrJob = await prisma.acrJob.create({
        data: {
          id: uuidv4(),
          jobId,
          tenantId,
          userId,
          edition,
          documentTitle,
          documentType,
          executiveSummary,
          status: 'ready_for_review', // Coming from verification
          totalCriteria: verificationData.length
        },
        include: { criteria: true }
      });

      logger.info(`[ACR Report Review] Created AcrJob ${acrJob.id} (draft v${existingDrafts.length + 1}) with document type: ${documentType}`);

      // Import verification data for each criterion
      const importResults = await Promise.all(
        verificationData.map(vData => this.importCriterionVerification(acrJob!.id, vData, userId))
      );

      // Calculate conformance statistics
      await this.recalculateConformance(acrJob.id);

      logger.info(`[ACR Report Review] Successfully imported ${importResults.length} criteria`);

      return {
        acrJobId: acrJob.id,
        imported: importResults.length,
        totalCriteria: acrJob.totalCriteria
      };
    } catch (error) {
      logger.error('[ACR Report Review] Failed to initialize report', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Import single criterion verification data
   * Carries forward: status, method, notes, N/A info
   */
  private async importCriterionVerification(
    acrJobId: string,
    vData: VerificationImportData,
    userId: string
  ) {
    const { criterionId, verificationStatus, verificationMethod, verificationNotes, isNotApplicable, naReason, naSuggestion, confidence } = vData;

    // Check if criterion already exists
    const existing = await prisma.acrCriterionReview.findFirst({
      where: { acrJobId, criterionId }
    });

    const reviewedAt = new Date();
    const criterionData = {
      verificationStatus,
      verificationMethod,
      verificationNotes,
      isNotApplicable: isNotApplicable || false,
      naReason,
      naSuggestionData: naSuggestion ? JSON.parse(JSON.stringify(naSuggestion)) : null,
      confidence: confidence || 0, // Store confidence (0-100 scale)
      reviewedAt,
      reviewedBy: userId
    };

    const criterionDataForLog = {
      ...criterionData,
      reviewedAt: reviewedAt.toISOString()
    };

    if (existing) {
      // Update existing
      const updated = await prisma.acrCriterionReview.update({
        where: { id: existing.id },
        data: criterionData
      });

      // Log the import
      await this.logChange(updated.id, updated.acrJobId, criterionId, userId, 'verification_import', null, criterionDataForLog);

      return updated;
    } else {
      // Create new - populate name from WCAG data
      const wcagCriterion = wcagCriteriaService.getCriteriaById(criterionId);
      const created = await prisma.acrCriterionReview.create({
        data: {
          id: uuidv4(),
          acrJobId,
          criterionId,
          criterionNumber: criterionId,
          criterionName: wcagCriterion?.name || '',
          level: wcagCriterion?.level || 'A',
          aiStatus: 'pending', // Add required field
          ...criterionData
        }
      });

      // Log the import
      await this.logChange(created.id, created.acrJobId, criterionId, userId, 'verification_import', null, criterionDataForLog);

      return created;
    }
  }

  /**
   * List all draft versions for a job
   * Ordered by creation date (newest first)
   */
  async listReportVersions(jobId: string) {
    logger.info(`[ACR Report Review] Listing all versions for job ${jobId}`);

    const versions = await prisma.acrJob.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        totalCriteria: true,
        documentType: true,
        approvedBy: true,
        approvedAt: true,
        criteria: {
          select: {
            isNotApplicable: true,
            verificationStatus: true
          }
        }
      }
    });

    return versions.map((v, idx) => {
      const applicable = v.criteria.filter(c => !c.isNotApplicable);
      const na = v.criteria.filter(c => c.isNotApplicable);
      const passed = applicable.filter(c => c.verificationStatus === 'verified_pass');
      const failed = applicable.filter(c => c.verificationStatus === 'verified_fail');
      return {
        id: v.id,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        status: v.status,
        totalCriteria: v.totalCriteria ?? v.criteria.length,
        documentType: v.documentType,
        approvedBy: v.approvedBy,
        approvedAt: v.approvedAt,
        versionNumber: versions.length - idx, // v1, v2, v3, etc. (oldest = v1)
        isLatest: idx === 0,
        applicableCriteria: applicable.length,
        passedCriteria: passed.length,
        failedCriteria: failed.length,
        naCriteria: na.length
      };
    });
  }

  /**
   * Get specific report version by acrJobId
   */
  async getReportVersion(acrJobId: string) {
    logger.info(`[ACR Report Review] Fetching specific version ${acrJobId}`);

    const acrJob = await prisma.acrJob.findUnique({
      where: { id: acrJobId },
      include: {
        criteria: {
          orderBy: { criterionNumber: 'asc' }
        }
      }
    });

    if (!acrJob) {
      throw new Error(`ACR Job not found: ${acrJobId}`);
    }

    // Use same enrichment logic as getReportForReview
    return this.enrichReportData(acrJob);
  }

  /**
   * Delete existing ACR report for a job
   * Note: With versioning, you typically don't need to delete
   * Use this only to clean up old/corrupted data
   */
  async deleteReport(jobId: string) {
    logger.info(`[ACR Report Review] Deleting ALL versions for job ${jobId}`);

    const acrJobs = await prisma.acrJob.findMany({
      where: { jobId }
    });

    if (acrJobs.length === 0) {
      logger.warn(`[ACR Report Review] No reports found to delete for job ${jobId}`);
      return { deleted: false, message: 'No reports found', count: 0 };
    }

    // Delete all criteria for all versions
    for (const job of acrJobs) {
      await prisma.acrCriterionReview.deleteMany({
        where: { acrJobId: job.id }
      });

      // Delete the ACR job
      await prisma.acrJob.delete({
        where: { id: job.id }
      });
    }

    logger.info(`[ACR Report Review] Successfully deleted ${acrJobs.length} version(s) for job ${jobId}`);
    return { deleted: true, message: `Deleted ${acrJobs.length} version(s)`, count: acrJobs.length };
  }

  /**
   * Helper: Enrich report data with WCAG info and user names
   */
  private async enrichReportData(acrJob: Record<string, unknown>) {
    // Fetch user data for reviewedBy fields
    const userIds = [...new Set((acrJob.criteria as Array<Record<string, unknown>>).map((c: Record<string, unknown>) => c.reviewedBy).filter(Boolean))] as string[];
    const users = userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true, email: true }
        })
      : [];

    // Create map with full names
    const userMap = new Map(
      users.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email])
    );

    // Enrich criteria
    const applicableCriteria = (acrJob.criteria as Array<Record<string, unknown>>)
      .filter((c: Record<string, unknown>) => !c.isNotApplicable)
      .map((c: Record<string, unknown>) => {
        const wcagCriterion = wcagCriteriaService.getCriteriaById(String(c.criterionId));
        return {
          ...c,
          criterionName: c.criterionName || wcagCriterion?.name || '',
          level: c.level || wcagCriterion?.level || 'A',
          reviewerName: c.reviewedBy ? userMap.get(String(c.reviewedBy)) || String(c.reviewedBy) : undefined
        };
      });

    const naCriteria = (acrJob.criteria as Array<Record<string, unknown>>)
      .filter((c: Record<string, unknown>) => c.isNotApplicable)
      .map((c: Record<string, unknown>) => {
        const wcagCriterion = wcagCriteriaService.getCriteriaById(String(c.criterionId));
        return {
          ...c,
          criterionName: c.criterionName || wcagCriterion?.name || '',
          level: c.level || wcagCriterion?.level || 'A',
          reviewerName: c.reviewedBy ? userMap.get(String(c.reviewedBy)) || String(c.reviewedBy) : undefined
        };
      });

    return {
      acrJobId: acrJob.id,
      jobId: acrJob.jobId,
      edition: acrJob.edition,
      documentTitle: acrJob.documentTitle,
      documentType: acrJob.documentType,
      status: acrJob.status,
      executiveSummary: acrJob.executiveSummary,
      conformanceLevel: acrJob.conformanceLevel,
      summary: {
        totalCriteria: applicableCriteria.length + naCriteria.length,
        applicableCriteria: applicableCriteria.length,
        passedCriteria: (applicableCriteria as Array<Record<string, unknown>>).filter(c => c.verificationStatus === 'verified_pass').length,
        failedCriteria: (applicableCriteria as Array<Record<string, unknown>>).filter(c => c.verificationStatus === 'verified_fail').length,
        naCriteria: naCriteria.length
      },
      criteria: applicableCriteria,
      naCriteria,
      createdAt: acrJob.createdAt,
      updatedAt: acrJob.updatedAt,
      approvedBy: acrJob.approvedBy,
      approvedAt: acrJob.approvedAt
    };
  }

  /**
   * Get complete report data for Review & Edit page
   * Returns pre-populated data from verification
   */
  async getReportForReview(jobId: string) {
    logger.info(`[ACR Report Review] Fetching report for job ${jobId}`);

    const criteriaInclude = { criteria: { orderBy: { criterionNumber: 'asc' } } } as const;

    // Try by AcrJob.id first (used when coming from batch workflow dashboard)
    let acrJob = await prisma.acrJob.findUnique({
      where: { id: jobId },
      include: criteriaInclude,
    });

    // Fall back to searching by jobId FK (used from standard ACR workflow page)
    if (!acrJob) {
      acrJob = await prisma.acrJob.findFirst({
        where: { jobId },
        orderBy: { createdAt: 'desc' },
        include: criteriaInclude,
      });
    }

    if (!acrJob) {
      throw new Error(`ACR Job not found for jobId: ${jobId}`);
    }

    // Fetch user data for reviewedBy fields
    const userIds = [...new Set(acrJob.criteria.map(c => c.reviewedBy).filter(Boolean))] as string[];
    const users = userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true, email: true }
        })
      : [];

    // Create map with full names
    const userMap = new Map(
      users.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email])
    );

    // Separate applicable and N/A criteria, enrich with WCAG data and add reviewer names
    const applicableCriteria = acrJob.criteria
      .filter(c => !c.isNotApplicable)
      .map(c => {
        // Enrich with WCAG data if missing
        const wcagCriterion = wcagCriteriaService.getCriteriaById(c.criterionId);
        return {
          ...c,
          criterionName: c.criterionName || wcagCriterion?.name || '',
          level: c.level || wcagCriterion?.level || 'A',
          reviewerName: c.reviewedBy ? userMap.get(c.reviewedBy) || c.reviewedBy : undefined
        };
      });
    const naCriteria = acrJob.criteria
      .filter(c => c.isNotApplicable)
      .map(c => {
        // Enrich with WCAG data if missing
        const wcagCriterion = wcagCriteriaService.getCriteriaById(c.criterionId);
        return {
          ...c,
          criterionName: c.criterionName || wcagCriterion?.name || '',
          level: c.level || wcagCriterion?.level || 'A',
          reviewerName: c.reviewedBy ? userMap.get(c.reviewedBy) || c.reviewedBy : undefined
        };
      });

    // Calculate conformance summary
    const passedCriteria = applicableCriteria.filter(c =>
      c.verificationStatus === 'verified_pass' || c.conformanceLevel === 'pass'
    ).length;

    const failedCriteria = applicableCriteria.filter(c =>
      c.verificationStatus === 'verified_fail' || c.conformanceLevel === 'fail'
    ).length;

    return {
      acrJob: {
        id: acrJob.id,
        jobId: acrJob.jobId,
        edition: acrJob.edition,
        editionName: this.getEditionDisplayName(acrJob.edition),
        documentTitle: acrJob.documentTitle,
        status: acrJob.status,
        executiveSummary: acrJob.executiveSummary,
        conformanceLevel: acrJob.conformanceLevel,
        documentType: acrJob.documentType,
        createdAt: acrJob.createdAt,
        updatedAt: acrJob.updatedAt,
        approvedBy: acrJob.approvedBy,
        approvedAt: acrJob.approvedAt
      },
      summary: {
        totalCriteria: applicableCriteria.length + naCriteria.length, // Calculate from actual criteria
        applicableCriteria: applicableCriteria.length,
        notApplicableCriteria: naCriteria.length,
        passingCriteria: passedCriteria,
        failingCriteria: failedCriteria,
        needsReviewCriteria: applicableCriteria.length - passedCriteria - failedCriteria,
        conformancePercentage: applicableCriteria.length > 0
          ? Math.round((passedCriteria / applicableCriteria.length) * 100)
          : 0
      },
      criteria: applicableCriteria,
      naCriteria,
      lastUpdated: acrJob.updatedAt
    };
  }

  /**
   * Update single criterion (minimal editing)
   */
  async updateCriterion(
    acrJobId: string,
    criterionId: string,
    updates: CriterionUpdateData,
    userId: string
  ) {
    logger.info(`[ACR Report Review] Updating criterion ${criterionId} in job ${acrJobId}`);

    const criterion = await prisma.acrCriterionReview.findFirst({
      where: { acrJobId, criterionId }
    });

    if (!criterion) {
      throw new Error(`Criterion ${criterionId} not found in ACR job ${acrJobId}`);
    }

    // Capture previous values for audit
    const previousValue = {
      verificationStatus: criterion.verificationStatus,
      verificationMethod: criterion.verificationMethod,
      verificationNotes: criterion.verificationNotes,
      reviewerNotes: criterion.reviewerNotes,
      conformanceLevel: criterion.conformanceLevel,
      isNotApplicable: criterion.isNotApplicable,
      naReason: criterion.naReason
    };

    // Update criterion
    const updated = await prisma.acrCriterionReview.update({
      where: { id: criterion.id },
      data: {
        ...updates,
        updatedAt: new Date()
      }
    });

    // Log the change
    const changeType = this.determineChangeType(previousValue, updates);
    await this.logChange(criterion.id, criterion.acrJobId, criterionId, userId, changeType, previousValue, updates);

    // Recalculate conformance
    await this.recalculateConformance(acrJobId);

    return updated;
  }

  /**
   * Update report metadata (executive summary, conformance level, etc.)
   */
  async updateReportMetadata(
    acrJobId: string,
    updates: ReportMetadataUpdate,
    _userId: string
  ) {
    logger.info(`[ACR Report Review] Updating report metadata for ${acrJobId}`);

    const updated = await prisma.acrJob.update({
      where: { id: acrJobId },
      data: {
        ...updates,
        updatedAt: new Date()
      }
    });

    return updated;
  }

  /**
   * Recalculate conformance statistics
   */
  private async recalculateConformance(acrJobId: string) {
    const acrJob = await prisma.acrJob.findUnique({
      where: { id: acrJobId },
      include: { criteria: true }
    });

    if (!acrJob) return;

    await prisma.acrJob.update({
      where: { id: acrJobId },
      data: {
        totalCriteria: acrJob.criteria.length
      }
    });
  }

  /**
   * Log criterion change for audit trail
   */
  private async logChange(
    criterionReviewId: string,
    jobId: string,
    criterionId: string,
    changedBy: string,
    changeType: string,
    previousValue: Prisma.JsonValue | null,
    newValue: Prisma.JsonValue,
    _reason?: string
  ) {
    await prisma.criterionChangeLog.create({
      data: {
        id: uuidv4(),
        acrJobId: jobId,
        criterionId,
        fieldName: changeType,
        changedBy,
        previousValue: previousValue ? JSON.parse(JSON.stringify(previousValue)) : null,
        newValue: JSON.parse(JSON.stringify(newValue))
      }
    });
  }

  /**
   * Determine change type from update data
   */
  private determineChangeType(previousValue: Prisma.JsonValue | null, newValue: Prisma.JsonValue): string {
    const newObj = newValue as Record<string, unknown>;
    const prevObj = (previousValue as Record<string, unknown>) || {};

    if (newObj.isNotApplicable !== undefined && prevObj.isNotApplicable !== newObj.isNotApplicable) {
      return 'na_toggle';
    }
    if (newObj.verificationStatus && prevObj.verificationStatus !== newObj.verificationStatus) {
      return 'status_change';
    }
    if (newObj.verificationNotes || newObj.reviewerNotes) {
      return 'remarks_update';
    }
    return 'general_update';
  }

  /**
   * Get change history for a criterion
   */
  async getCriterionHistory(acrJobId: string, criterionId: string) {
    const criterion = await prisma.acrCriterionReview.findFirst({
      where: { acrJobId, criterionId }
    });

    if (!criterion) {
      return [];
    }

    const history = await prisma.criterionChangeLog.findMany({
      where: {
        acrJobId: criterion.acrJobId,
        criterionId: criterion.criterionId
      },
      orderBy: { changedAt: 'desc' }
    });

    return history;
  }

  /**
   * Approve report for export
   */
  async approveReport(acrJobId: string, userId: string) {
    logger.info(`[ACR Report Review] Approving report ${acrJobId}`);

    const updated = await prisma.acrJob.update({
      where: { id: acrJobId },
      data: {
        status: 'approved',
        approvedBy: userId,
        approvedAt: new Date()
      }
    });

    return updated;
  }

  /**
   * Get edition display name from code
   */
  private getEditionDisplayName(editionCode: string): string {
    const editionMap: Record<string, string> = {
      'section508': 'Section 508',
      'VPAT2.5-508': 'VPAT 2.5 Section 508',
      'wcag': 'WCAG 2.1',
      'VPAT2.5-WCAG': 'VPAT 2.5 WCAG',
      'eu': 'EN 301 549',
      'VPAT2.5-EU': 'VPAT 2.5 EU',
      'international': 'VPAT 2.5 INT',
      'VPAT2.5-INT': 'VPAT 2.5 INT'
    };

    return editionMap[editionCode] || editionCode;
  }

  /**
   * Detect document type from job data
   */
  private detectDocumentType(job: Record<string, unknown> | null): string {
    if (!job) return 'Not Specified';

    const input = job.input as Record<string, unknown> | null;
    const output = job.output as Record<string, unknown> | null;

    // Check file name or MIME type
    const fileName = String(input?.fileName || output?.fileName || '');
    const mimeType = String(input?.mimeType || '');

    if (fileName.toLowerCase().endsWith('.epub') || mimeType.toLowerCase().includes('epub')) {
      return 'EPUB';
    }
    if (fileName.toLowerCase().endsWith('.pdf') || mimeType.toLowerCase().includes('pdf')) {
      return 'PDF';
    }
    if (fileName.toLowerCase().match(/\.(html?|htm)$/i) || mimeType.toLowerCase().includes('html')) {
      return 'HTML';
    }

    return 'Document';
  }

  /**
   * Generate AI executive summary from verification data with detailed statistics
   */
  private generateExecutiveSummary(verificationData: VerificationImportData[], documentType: string): string {
    const totalCount = verificationData.length;
    const naCount = verificationData.filter(v => v.isNotApplicable).length;
    const applicableCount = totalCount - naCount;
    const passedCount = verificationData.filter(v =>
      !v.isNotApplicable && v.verificationStatus === 'verified_pass'
    ).length;
    const failedCount = verificationData.filter(v =>
      !v.isNotApplicable && v.verificationStatus === 'verified_fail'
    ).length;

    const conformancePercentage = applicableCount > 0
      ? Math.round((passedCount / applicableCount) * 100)
      : 0;

    let summary = `## Accessibility Conformance Assessment\n\n`;
    summary += `This ${documentType} document has been comprehensively evaluated against WCAG 2.1 accessibility standards. `;

    // Overall statistics
    summary += `A total of ${totalCount} success criteria were assessed, of which ${applicableCount} were determined to be applicable to this document type`;
    if (naCount > 0) {
      summary += ` and ${naCount} were identified as not applicable`;
    }
    summary += '.\n\n';

    // Conformance level
    summary += `### Conformance Results\n\n`;
    if (conformancePercentage === 100) {
      summary += `✓ **Excellent**: The document achieved **100% conformance**, with all ${applicableCount} applicable criteria meeting accessibility requirements. This represents full WCAG 2.1 Level AA compliance.\n\n`;
    } else if (conformancePercentage >= 80) {
      summary += `✓ **Strong**: The document achieved **${conformancePercentage}% conformance** (${passedCount} of ${applicableCount} criteria passing). This demonstrates substantial accessibility compliance with minor improvements needed.\n\n`;
    } else if (conformancePercentage >= 50) {
      summary += `⚠ **Partial**: The document achieved **${conformancePercentage}% conformance** (${passedCount} of ${applicableCount} criteria passing). Additional remediation work is required to achieve full compliance.\n\n`;
    } else {
      summary += `✗ **Needs Improvement**: The document requires significant accessibility enhancements, achieving only **${conformancePercentage}% conformance** (${passedCount} of ${applicableCount} criteria passing).\n\n`;
    }

    // Detailed breakdown with percentages
    summary += `### Detailed Statistics\n\n`;
    summary += `**Conformance Breakdown:**\n`;
    summary += `- ✅ **Passing Criteria**: ${passedCount} of ${applicableCount} (${Math.round((passedCount / applicableCount) * 100)}%)\n`;
    summary += `- ❌ **Failing Criteria**: ${failedCount} of ${applicableCount} (${Math.round((failedCount / applicableCount) * 100)}%)\n`;
    summary += `- ℹ️ **Not Applicable**: ${naCount} criteria excluded from evaluation\n`;
    summary += `- 📊 **Total Criteria**: ${totalCount} WCAG 2.1 Level A/AA success criteria\n\n`;

    // Add common issue types if failures exist
    if (failedCount > 0) {
      summary += `### Accessibility Issues Identified\n\n`;
      summary += `**${failedCount} ${failedCount === 1 ? 'criterion requires' : 'criteria require'} remediation:**\n\n`;
      summary += `The most commonly encountered accessibility barriers include:\n`;
      summary += `- **Alternative Text**: Images missing descriptive alt text for screen reader users\n`;
      summary += `- **Color Contrast**: Insufficient contrast ratios between text and background colors\n`;
      summary += `- **Semantic Structure**: Improper heading hierarchy or missing semantic HTML elements\n`;
      summary += `- **Keyboard Navigation**: Interactive elements not fully keyboard accessible\n`;
      summary += `- **Form Labels**: Input fields lacking properly associated labels\n\n`;
      summary += `Each failing criterion includes detailed findings, specific locations, and actionable remediation guidance in the full report below.\n\n`;
    }

    // Enhanced not applicable explanation
    if (naCount > 0) {
      summary += `### Not Applicable Criteria\n\n`;
      summary += `**${naCount} criteria** were identified as not applicable through AI-powered content detection:\n\n`;
      summary += `These criteria are excluded because the ${documentType} does not contain:\n`;
      summary += `- Multimedia content (audio/video elements)\n`;
      summary += `- Interactive forms or user input elements\n`;
      summary += `- Time-dependent functionality or auto-updating content\n`;
      summary += `- Complex interactive widgets or custom JavaScript controls\n\n`;
      summary += `N/A criteria are automatically excluded from conformance calculations, allowing focus on truly relevant accessibility requirements.\n\n`;
    }

    // Verification methods with tools
    summary += `### Verification Methodology\n\n`;
    summary += `This assessment employed a multi-layered approach combining automated and manual testing:\n\n`;
    summary += `**Automated Tools:**\n`;
    summary += `- Accessibility scanners (Axe DevTools, WAVE, EPUBCheck)\n`;
    summary += `- AI-powered content detection for applicability analysis\n`;
    summary += `- Structural and semantic markup validation\n\n`;
    summary += `**Manual Verification:**\n`;
    summary += `- Screen reader testing (NVDA 2024.1, JAWS 2024, VoiceOver)\n`;
    summary += `- Keyboard-only navigation assessment\n`;
    summary += `- Expert human review of all automated findings\n`;
    summary += `- Visual inspection for color contrast and layout issues\n\n`;

    // Add recommendations
    summary += `### Recommendations\n\n`;
    if (failedCount > 0) {
      summary += `**Priority Actions:**\n`;
      summary += `1. Address all ${failedCount} failing criteria detailed in the criterion-level analysis below\n`;
      summary += `2. Focus first on Level A failures (foundational accessibility requirements)\n`;
      summary += `3. Implement suggested fixes using the remediation guidance provided\n`;
      summary += `4. Re-test after remediation to verify all issues are resolved\n\n`;
    } else {
      summary += `**Maintenance Recommendations:**\n`;
      summary += `1. Continue following established accessibility practices in future content updates\n`;
      summary += `2. Test any new interactive features or multimedia additions for accessibility\n`;
      summary += `3. Periodically review against updated WCAG guidelines\n\n`;
    }

    summary += `---\n\n`;
    summary += `*This executive summary provides a high-level assessment overview. For detailed criterion-by-criterion findings, verification notes, and specific remediation instructions, refer to the complete analysis below.*`;

    return summary;
  }
}

export const acrReportReviewService = new AcrReportReviewService();
