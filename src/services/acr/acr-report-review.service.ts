import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { v4 as uuidv4 } from 'uuid';
import type { ApplicabilitySuggestion } from './content-detection.service';
import type { Prisma } from '@prisma/client';

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
}

interface CriterionUpdateData {
  verificationStatus?: string;
  verificationMethod?: string;
  verificationNotes?: string;
  reviewerNotes?: string;
  conformanceLevel?: string;
  isNotApplicable?: boolean;
  naReason?: string;
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

    try {
      // Check if AcrJob already exists
      let acrJob = await prisma.acrJob.findFirst({
        where: { jobId },
        include: { criteria: true }
      });

      if (!acrJob) {
        // Create new AcrJob
        acrJob = await prisma.acrJob.create({
          data: {
            id: uuidv4(),
            jobId,
            tenantId,
            userId,
            edition,
            documentTitle,
            status: 'ready_for_review', // Coming from verification
            totalCriteria: verificationData.length,
            applicableCriteria: verificationData.filter(v => !v.isNotApplicable).length,
            naCriteria: verificationData.filter(v => v.isNotApplicable).length
          },
          include: { criteria: true }
        });

        logger.info(`[ACR Report Review] Created AcrJob ${acrJob.id}`);
      }

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
    const { criterionId, verificationStatus, verificationMethod, verificationNotes, isNotApplicable, naReason, naSuggestion } = vData;

    // Check if criterion already exists
    const existing = await prisma.acrCriterionReview.findFirst({
      where: { acrJobId, criterionId }
    });

    const criterionData = {
      verificationStatus,
      verificationMethod,
      verificationNotes,
      isNotApplicable: isNotApplicable || false,
      naReason,
      naSuggestionData: naSuggestion ? JSON.parse(JSON.stringify(naSuggestion)) : null,
      reviewedAt: new Date(),
      reviewedBy: userId
    };

    if (existing) {
      // Update existing
      const updated = await prisma.acrCriterionReview.update({
        where: { id: existing.id },
        data: criterionData
      });

      // Log the import
      await this.logChange(updated.id, updated.acrJobId, criterionId, userId, 'verification_import', null, criterionData);

      return updated;
    } else {
      // Create new
      const created = await prisma.acrCriterionReview.create({
        data: {
          id: uuidv4(),
          acrJobId,
          criterionId,
          criterionNumber: criterionId,
          criterionName: '', // Will be populated from WCAG data
          ...criterionData
        }
      });

      // Log the import
      await this.logChange(created.id, created.acrJobId, criterionId, userId, 'verification_import', null, criterionData);

      return created;
    }
  }

  /**
   * Get complete report data for Review & Edit page
   * Returns pre-populated data from verification
   */
  async getReportForReview(jobId: string) {
    logger.info(`[ACR Report Review] Fetching report for job ${jobId}`);

    const acrJob = await prisma.acrJob.findFirst({
      where: { jobId },
      include: {
        criteria: {
          orderBy: { criterionNumber: 'asc' }
        }
      }
    });

    if (!acrJob) {
      throw new Error(`ACR Job not found for jobId: ${jobId}`);
    }

    // Separate applicable and N/A criteria
    const applicableCriteria = acrJob.criteria.filter(c => !c.isNotApplicable);
    const naCriteria = acrJob.criteria.filter(c => c.isNotApplicable);

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
        totalCriteria: acrJob.totalCriteria,
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

    const applicableCriteria = acrJob.criteria.filter(c => !c.isNotApplicable);
    const naCriteria = acrJob.criteria.filter(c => c.isNotApplicable);

    const passedCriteria = applicableCriteria.filter(c =>
      c.verificationStatus === 'verified_pass' || c.conformanceLevel === 'pass'
    ).length;

    const failedCriteria = applicableCriteria.filter(c =>
      c.verificationStatus === 'verified_fail' || c.conformanceLevel === 'fail'
    ).length;

    await prisma.acrJob.update({
      where: { id: acrJobId },
      data: {
        totalCriteria: acrJob.criteria.length,
        applicableCriteria: applicableCriteria.length,
        naCriteria: naCriteria.length,
        passedCriteria,
        failedCriteria
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
    reason?: string
  ) {
    await prisma.criterionChangeLog.create({
      data: {
        id: uuidv4(),
        criterionReviewId,
        jobId,
        criterionId,
        changedBy,
        changeType,
        previousValue: previousValue ? JSON.parse(JSON.stringify(previousValue)) : null,
        newValue: JSON.parse(JSON.stringify(newValue)),
        reason
      }
    });
  }

  /**
   * Determine change type from update data
   */
  private determineChangeType(previousValue: Prisma.JsonValue | null, newValue: Prisma.JsonValue): string {
    if (newValue.isNotApplicable !== undefined && previousValue.isNotApplicable !== newValue.isNotApplicable) {
      return 'na_toggle';
    }
    if (newValue.verificationStatus && previousValue.verificationStatus !== newValue.verificationStatus) {
      return 'status_change';
    }
    if (newValue.verificationNotes || newValue.reviewerNotes) {
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
      where: { criterionReviewId: criterion.id },
      orderBy: { createdAt: 'desc' }
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
}

export const acrReportReviewService = new AcrReportReviewService();
