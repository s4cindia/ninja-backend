import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { remediationService } from '../epub/remediation.service';
import {
  BatchAcrOptions,
  BatchAcrGenerationResult,
  IndividualAcrGenerationResult,
  AggregateAcrGenerationResult,
  ConformanceLevel,
  BatchNotFoundError,
  IncompleteBatchError,
  InvalidAcrOptionsError,
} from '../../types/batch-acr.types';

interface TaskWithSource {
  id: string;
  issueCode: string;
  issueMessage: string;
  severity: string;
  location?: string;
  status: string;
  wcagCriteria?: string | string[];
  jobId: string;
  fileName: string;
}

interface PerEpubDetail {
  fileName: string;
  jobId: string;
  status: ConformanceLevel;
  issueCount: number;
  issues: Array<{
    code: string;
    message: string;
    location?: string;
  }>;
}

export class BatchAcrGeneratorService {
  private async getBatchFromDb(batchId: string, tenantId: string) {
    return prisma.batch.findFirst({
      where: { id: batchId, tenantId },
      include: {
        files: {
          select: {
            id: true,
            originalName: true,
            status: true,
            auditJobId: true,
            issuesFound: true,
          },
        },
      },
    });
  }

  async generateBatchAcr(
    batchId: string,
    tenantId: string,
    userId: string,
    mode: 'individual' | 'aggregate',
    options?: BatchAcrOptions
  ): Promise<BatchAcrGenerationResult> {
    logger.info(`Starting batch ACR generation for batch ${batchId}, mode: ${mode}`);

    const batch = await this.getBatchFromDb(batchId, tenantId);
    if (!batch) {
      throw new BatchNotFoundError(batchId);
    }

    if (batch.status !== 'COMPLETED') {
      const completedFiles = batch.files.filter(f => f.status === 'REMEDIATED').length;
      throw new IncompleteBatchError(batchId, completedFiles, batch.totalFiles);
    }

    if (mode === 'aggregate') {
      if (!options) {
        throw new InvalidAcrOptionsError('Options are required for aggregate mode');
      }
      if (!options.edition || !options.batchName || !options.vendor || !options.contactEmail) {
        throw new InvalidAcrOptionsError('edition, batchName, vendor, and contactEmail are required for aggregate mode');
      }
      return this.generateAggregateAcr(batchId, tenantId, userId, options);
    }

    return this.generateIndividualAcrs(batchId, tenantId, userId);
  }

  async generateIndividualAcrs(
    batchId: string,
    tenantId: string,
    userId: string
  ): Promise<IndividualAcrGenerationResult> {
    logger.info(`Generating individual ACRs for batch ${batchId}`);

    const batch = await this.getBatchFromDb(batchId, tenantId);
    if (!batch) {
      throw new BatchNotFoundError(batchId);
    }

    const successfulFiles = batch.files.filter(f => f.status === 'REMEDIATED' && f.auditJobId);

    if (successfulFiles.length === 0) {
      throw new Error('No successful files to generate ACRs from');
    }

    logger.info(`Found ${successfulFiles.length} successful files for ACR generation`);

    const acrWorkflowIds: string[] = [];
    const failedJobs: Array<{ jobId: string; error: string }> = [];

    for (const file of successfulFiles) {
      try {
        const result = await remediationService.transferToAcr(file.auditJobId!);
        acrWorkflowIds.push(result.acrWorkflowId);
        logger.info(`Created ACR workflow ${result.acrWorkflowId} for file ${file.originalName}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Failed to create ACR for file ${file.originalName}: ${errorMessage}`);
        failedJobs.push({ jobId: file.auditJobId || file.id, error: errorMessage });
      }
    }

    if (acrWorkflowIds.length === 0 && failedJobs.length > 0) {
      throw new Error(`Failed to create any ACRs. Errors: ${failedJobs.map(f => f.error).join(', ')}`);
    }

    await this.updateBatchAcrMetadata(batchId, {
      acrGenerated: true,
      acrMode: 'individual',
      acrWorkflowIds,
      acrGeneratedAt: new Date().toISOString(),
      generatedBy: userId,
    });

    const successMessage = failedJobs.length > 0
      ? `Created ${acrWorkflowIds.length} ACR workflows (${failedJobs.length} failed)`
      : `Created ${acrWorkflowIds.length} ACR workflows`;

    logger.info(`Batch ACR generation complete for ${batchId}: ${successMessage}`);

    return {
      mode: 'individual',
      acrWorkflowIds,
      totalAcrs: acrWorkflowIds.length,
      message: successMessage,
    };
  }

  async generateAggregateAcr(
    batchId: string,
    tenantId: string,
    userId: string,
    options: BatchAcrOptions
  ): Promise<AggregateAcrGenerationResult> {
    logger.info(`Generating aggregate ACR for batch ${batchId}`);

    if (!options.batchName || !options.vendor || !options.contactEmail || !options.edition) {
      throw new InvalidAcrOptionsError('Missing required options for aggregate ACR');
    }

    const batch = await this.getBatchFromDb(batchId, tenantId);
    if (!batch) {
      throw new BatchNotFoundError(batchId);
    }

    const successfulFiles = batch.files.filter(f => f.status === 'REMEDIATED' && f.auditJobId);
    if (successfulFiles.length === 0) {
      throw new Error('No successful files to generate aggregate ACR from');
    }

    logger.info(`Found ${successfulFiles.length} successful files for aggregate ACR`);
    
    // Map successfulFiles to successfulJobs format for use throughout the function
    const successfulJobs = successfulFiles.map(f => ({
      jobId: f.auditJobId!,
      fileName: f.originalName,
    }));

    const jobPlans = await Promise.all(
      successfulFiles.map(async (file) => {
        const plan = await remediationService.getRemediationPlan(file.auditJobId!);
        return { jobId: file.auditJobId!, fileName: file.originalName, plan };
      })
    );

    const allPendingTasks: TaskWithSource[] = jobPlans.flatMap(({ jobId, fileName, plan }) => {
      if (!plan) return [];
      const pendingTasks = plan.tasks.filter((t: { status: string }) => t.status === 'pending');
      return pendingTasks.map((task: { id: string; issueCode: string; issueMessage: string; severity: string; location?: string; status: string; wcagCriteria?: string | string[] }) => ({
        ...task,
        jobId,
        fileName,
      }));
    });

    logger.info(`Found ${allPendingTasks.length} pending tasks across all jobs`);

    const criteriaMap = new Map<string, TaskWithSource[]>();
    for (const task of allPendingTasks) {
      const wcagCriteria = Array.isArray(task.wcagCriteria)
        ? task.wcagCriteria
        : task.wcagCriteria ? [task.wcagCriteria] : [];

      for (const criterion of wcagCriteria) {
        if (!criteriaMap.has(criterion)) {
          criteriaMap.set(criterion, []);
        }
        criteriaMap.get(criterion)!.push(task);
      }
    }

    const aggregateCriteria: Array<{
      criterionId: string;
      criterionName: string;
      level: 'A' | 'AA' | 'AAA';
      conformanceLevel: ConformanceLevel;
      remarks: string;
      perEpubDetails: PerEpubDetail[];
    }> = [];

    for (const [criterionId, tasks] of criteriaMap.entries()) {
      const tasksByJob = new Map<string, TaskWithSource[]>();
      for (const task of tasks) {
        if (!tasksByJob.has(task.jobId)) {
          tasksByJob.set(task.jobId, []);
        }
        tasksByJob.get(task.jobId)!.push(task);
      }

      const perEpubDetails: PerEpubDetail[] = successfulJobs.map(job => {
        const jobTasks = tasksByJob.get(job.jobId) || [];
        const issueCount = jobTasks.length;

        return {
          fileName: job.fileName,
          jobId: job.jobId,
          status: (issueCount === 0 ? 'Supports' : 'Does Not Support') as ConformanceLevel,
          issueCount,
          issues: jobTasks.map(t => ({
            code: t.issueCode,
            message: t.issueMessage,
            location: t.location,
          })),
        };
      });

      const conformanceLevel = this.aggregateConformance(
        perEpubDetails,
        options.aggregationStrategy
      );

      const remarks = this.generateCompositeRemarks(criterionId, perEpubDetails);

      aggregateCriteria.push({
        criterionId,
        criterionName: `WCAG ${criterionId}`,
        level: this.getWcagLevel(criterionId),
        conformanceLevel,
        remarks,
        perEpubDetails,
      });
    }

    logger.info(`Generated ${aggregateCriteria.length} aggregate criteria`);

    const acrDocument = {
      sourceJobId: batchId,
      fileName: options.batchName,
      epubTitle: options.batchName,
      status: 'needs_verification',
      sourceType: 'batch_remediation',
      totalCriteria: aggregateCriteria.length,
      verifiedCount: 0,
      criteria: aggregateCriteria,
      batchInfo: {
        isBatch: true,
        totalDocuments: successfulJobs.length,
        documentList: successfulJobs.map(j => ({
          fileName: j.fileName,
          jobId: j.jobId,
        })),
        aggregationStrategy: options.aggregationStrategy,
        sourceJobIds: successfulJobs.map(j => j.jobId),
      },
      productInfo: {
        name: options.batchName,
        vendor: options.vendor,
        contactEmail: options.contactEmail,
        edition: options.edition,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const acrJob = await prisma.job.create({
      data: {
        tenantId,
        userId,
        type: 'ACR_WORKFLOW',
        status: 'PROCESSING',
        input: {
          sourceJobId: batchId,
          sourceType: 'batch_remediation',
          mode: 'aggregate',
        } as unknown as import('@prisma/client').Prisma.InputJsonValue,
        output: acrDocument as unknown as import('@prisma/client').Prisma.InputJsonValue,
        startedAt: new Date(),
        batchSourceJobIds: successfulJobs.map(j => j.jobId),
        isBatchAcr: true,
      },
    });

    logger.info(`Created ACR workflow job ${acrJob.id}`);

    const acrJobRecord = await prisma.acrJob.create({
      data: {
        jobId: acrJob.id,
        tenantId,
        userId,
        edition: options.edition,
        documentTitle: options.batchName,
        status: 'in_progress',
      },
    });

    logger.info(`Created AcrJob record ${acrJobRecord.id}`);

    for (const criterion of aggregateCriteria) {
      await prisma.acrCriterionReview.create({
        data: {
          acrJobId: acrJobRecord.id,
          criterionId: criterion.criterionId,
          criterionNumber: criterion.criterionId,
          criterionName: criterion.criterionName,
          level: criterion.level,
          conformanceLevel: criterion.conformanceLevel,
          reviewerNotes: criterion.remarks,
          confidence: 50,
          aiStatus: 'needs_review',
        },
      });
    }

    logger.info(`Created ${aggregateCriteria.length} AcrCriterionReview records`);

    await this.updateBatchAcrMetadata(batchId, {
      acrGenerated: true,
      acrMode: 'aggregate',
      acrWorkflowIds: [acrJob.id],
      acrGeneratedAt: new Date().toISOString(),
      generatedBy: userId,
    });

    const message = `Created aggregate ACR for ${successfulJobs.length} EPUBs with ${aggregateCriteria.length} criteria`;
    logger.info(`Aggregate ACR generation complete: ${message}`);

    return {
      mode: 'aggregate',
      acrWorkflowId: acrJob.id,
      totalDocuments: successfulJobs.length,
      totalCriteria: aggregateCriteria.length,
      message,
    };
  }

  private aggregateConformance(
    perEpubDetails: Array<{ status: ConformanceLevel; issueCount: number }>,
    strategy: 'conservative' | 'optimistic'
  ): ConformanceLevel {
    if (strategy === 'conservative') {
      return this.aggregateConformanceConservative(perEpubDetails);
    } else {
      return this.aggregateConformanceOptimistic(perEpubDetails);
    }
  }

  private aggregateConformanceConservative(
    results: Array<{ status: ConformanceLevel; issueCount: number }>
  ): ConformanceLevel {
    const allNotApplicable = results.every(r => r.status === 'Not Applicable');
    if (allNotApplicable) return 'Not Applicable';

    const hasDoesNotSupport = results.some(r => r.status === 'Does Not Support');
    if (hasDoesNotSupport) return 'Does Not Support';

    const hasPartiallySupports = results.some(r => r.status === 'Partially Supports');
    if (hasPartiallySupports) return 'Partially Supports';

    return 'Supports';
  }

  private aggregateConformanceOptimistic(
    results: Array<{ status: ConformanceLevel; issueCount: number }>
  ): ConformanceLevel {
    const allNotApplicable = results.every(r => r.status === 'Not Applicable');
    if (allNotApplicable) return 'Not Applicable';

    const supportsCount = results.filter(r => r.status === 'Supports').length;
    const total = results.length;

    if (supportsCount === total) return 'Supports';
    if (supportsCount >= total * 0.5) return 'Partially Supports';

    return 'Does Not Support';
  }

  private generateCompositeRemarks(
    criterionId: string,
    perEpubDetails: PerEpubDetail[]
  ): string {
    const supportsCount = perEpubDetails.filter(e => e.issueCount === 0).length;
    const total = perEpubDetails.length;
    const percentage = Math.round((supportsCount / total) * 100);

    let remarks = `${supportsCount} of ${total} EPUBs (${percentage}%) fully support criterion ${criterionId}.\n\n`;

    const failedEpubs = perEpubDetails.filter(e => e.issueCount > 0);

    if (failedEpubs.length > 0) {
      remarks += `EPUBs requiring attention:\n`;

      for (const epub of failedEpubs) {
        remarks += `\n- "${epub.fileName}" (${epub.issueCount} issue${epub.issueCount !== 1 ? 's' : ''})\n`;

        const issuesToShow = epub.issues.slice(0, 3);
        for (const issue of issuesToShow) {
          remarks += `  • ${issue.message}\n`;
        }

        if (epub.issues.length > 3) {
          remarks += `  • ... and ${epub.issues.length - 3} more\n`;
        }
      }
    }

    return remarks.trim();
  }

  private getWcagLevel(criterionId: string): 'A' | 'AA' | 'AAA' {
    const aaaCriteria = ['1.2.6', '1.2.7', '1.2.8', '1.2.9', '1.4.6', '1.4.7', '1.4.8', '1.4.9', '2.1.3', '2.2.3', '2.2.4', '2.2.5', '2.2.6', '2.3.2', '2.3.3', '2.4.8', '2.4.9', '2.4.10', '2.5.5', '2.5.6', '3.1.3', '3.1.4', '3.1.5', '3.1.6', '3.2.5', '3.3.5', '3.3.6'];
    const aaCriteria = ['1.2.4', '1.2.5', '1.3.4', '1.3.5', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.4.5', '2.4.6', '2.4.7', '2.5.3', '2.5.4', '3.1.2', '3.2.3', '3.2.4', '3.3.3', '3.3.4', '4.1.3'];

    if (aaaCriteria.includes(criterionId)) return 'AAA';
    if (aaCriteria.includes(criterionId)) return 'AA';
    return 'A';
  }

  private async updateBatchAcrMetadata(
    batchId: string,
    metadata: {
      acrGenerated: boolean;
      acrMode: 'individual' | 'aggregate';
      acrWorkflowIds: string[];
      acrGeneratedAt: string;
      generatedBy: string;
    }
  ): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new Error('Batch not found');
    }

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        acrGenerated: metadata.acrGenerated,
        acrMode: metadata.acrMode,
        acrWorkflowIds: metadata.acrWorkflowIds,
        acrGeneratedAt: new Date(metadata.acrGeneratedAt),
      },
    });

    logger.info(`Updated batch ${batchId} with ACR metadata`);
  }
}

export const batchAcrGeneratorService = new BatchAcrGeneratorService();
