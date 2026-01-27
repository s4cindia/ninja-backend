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

    return this.generateIndividualAcrs(batchId, tenantId, userId, options);
  }

  async generateIndividualAcrs(
    batchId: string,
    tenantId: string,
    userId: string,
    options?: BatchAcrOptions
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
        const transferOptions = options ? {
          edition: options.edition,
          productName: options.batchName,
          vendor: options.vendor,
          contactEmail: options.contactEmail,
        } : undefined;
        const result = await remediationService.transferToAcr(file.auditJobId!, transferOptions);
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
      issuesFound: f.issuesFound || 0,
    }));

    // Fetch WCAG analysis from Job outputs (contains comprehensive criteria evaluation)
    const jobAnalyses = await Promise.all(
      successfulFiles.map(async (file) => {
        const job = await prisma.job.findFirst({
          where: { id: file.auditJobId! },
          select: { id: true, output: true }
        });
        
        const output = job?.output as Record<string, unknown> | null;
        const acrAnalysis = output?.acrAnalysis as { 
          criteria?: Array<{
            id: string;
            name: string;
            level: string;
            status: string;
            category?: string;
            findings?: string[];
            recommendation?: string;
            issueCount?: number;
            fixedCount?: number;
            remainingCount?: number;
            fixedIssues?: Array<{ message: string; location?: string }>;
            relatedIssues?: Array<{ message: string; location?: string; ruleId?: string }>;
          }>;
          summary?: { supports: number; partiallySupports: number; doesNotSupport: number; notApplicable: number };
        } | null;
        
        // Also get remediation plan for additional issue context
        const plan = await remediationService.getRemediationPlan(file.auditJobId!);
        
        return { 
          jobId: file.auditJobId!, 
          fileName: file.originalName,
          acrAnalysis,
          plan,
          issuesFound: file.issuesFound || 0
        };
      })
    );

    logger.info(`Fetched analysis for ${jobAnalyses.length} jobs`);

    // Build comprehensive criteria map from all job analyses
    const criteriaMap = new Map<string, {
      criterionId: string;
      criterionName: string;
      level: 'A' | 'AA' | 'AAA';
      category?: string;
      perJobData: Array<{
        jobId: string;
        fileName: string;
        status: string;
        issueCount: number;
        fixedCount: number;
        remainingCount?: number;
        findings: string[];
        issues: Array<{ code?: string; message: string; location?: string }>;
      }>;
    }>();

    // Process each job's WCAG criteria
    for (const { jobId, fileName, acrAnalysis, plan } of jobAnalyses) {
      if (acrAnalysis?.criteria && Array.isArray(acrAnalysis.criteria)) {
        for (const criterion of acrAnalysis.criteria) {
          if (!criterion.id) continue;
          
          if (!criteriaMap.has(criterion.id)) {
            criteriaMap.set(criterion.id, {
              criterionId: criterion.id,
              criterionName: criterion.name || `WCAG ${criterion.id}`,
              level: (criterion.level || 'A') as 'A' | 'AA' | 'AAA',
              category: criterion.category,
              perJobData: []
            });
          }
          
          // Collect issues from plan tasks that match this criterion
          const relatedPlanIssues: Array<{ code?: string; message: string; location?: string }> = [];
          if (plan?.tasks) {
            for (const task of plan.tasks) {
              // Check if task relates to this criterion
              const taskWcag = Array.isArray(task.wcagCriteria) ? task.wcagCriteria : 
                               task.wcagCriteria ? [task.wcagCriteria] : [];
              if (taskWcag.includes(criterion.id)) {
                relatedPlanIssues.push({
                  code: task.issueCode,
                  message: task.issueMessage,
                  location: task.location
                });
              }
            }
          }
          
          // Add issues from criterion's relatedIssues
          const criterionIssues = (criterion.relatedIssues || []).map(i => ({
            code: i.ruleId,
            message: i.message,
            location: i.location
          }));
          
          // Combine all issues
          const allIssues = [...relatedPlanIssues, ...criterionIssues];
          
          criteriaMap.get(criterion.id)!.perJobData.push({
            jobId,
            fileName,
            status: criterion.status || 'supports',
            issueCount: criterion.issueCount ?? 0,
            fixedCount: criterion.fixedCount ?? 0,
            remainingCount: criterion.remainingCount,  // Preserve undefined
            findings: criterion.findings || [],
            issues: allIssues
          });
        }
      }
    }

    logger.info(`Aggregated ${criteriaMap.size} WCAG criteria from all job analyses`);

    // Build final aggregate criteria array
    const aggregateCriteria: Array<{
      criterionId: string;
      criterionName: string;
      level: 'A' | 'AA' | 'AAA';
      conformanceLevel: ConformanceLevel;
      remarks: string;
      perEpubDetails: PerEpubDetail[];
    }> = [];

    for (const [criterionId, criterionData] of criteriaMap.entries()) {
      // Map perJobData to perEpubDetails format
      const perEpubDetails: PerEpubDetail[] = criterionData.perJobData.map(jobData => {
        // Determine conformance level based on status
        let status: ConformanceLevel;
        switch (jobData.status) {
          case 'supports':
            status = 'Supports';
            break;
          case 'partially_supports':
            status = 'Partially Supports';
            break;
          case 'does_not_support':
            status = 'Does Not Support';
            break;
          case 'not_applicable':
            status = 'Not Applicable';
            break;
          default:
            status = (jobData.remainingCount ?? jobData.issueCount) > 0 ? 'Does Not Support' : 'Supports';
        }
        
        return {
          fileName: jobData.fileName,
          jobId: jobData.jobId,
          status,
          issueCount: jobData.remainingCount !== undefined ? jobData.remainingCount : jobData.issueCount,
          issues: jobData.issues.map(i => ({
            code: i.code || '',
            message: i.message,
            location: i.location
          }))
        };
      });

      // Ensure all jobs are represented (even if they don't have this criterion explicitly)
      for (const job of successfulJobs) {
        if (!perEpubDetails.some(d => d.jobId === job.jobId)) {
          perEpubDetails.push({
            fileName: job.fileName,
            jobId: job.jobId,
            status: 'Supports', // No issues means supports
            issueCount: 0,
            issues: []
          });
        }
      }

      const conformanceLevel = this.aggregateConformance(
        perEpubDetails,
        options.aggregationStrategy
      );

      const remarks = this.generateCompositeRemarks(criterionId, perEpubDetails);

      aggregateCriteria.push({
        criterionId,
        criterionName: criterionData.criterionName,
        level: criterionData.level,
        conformanceLevel,
        remarks,
        perEpubDetails,
      });
    }

    // Sort criteria by WCAG number
    aggregateCriteria.sort((a, b) => {
      const aParts = a.criterionId.split('.').map(n => parseInt(n) || 0);
      const bParts = b.criterionId.split('.').map(n => parseInt(n) || 0);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        if ((aParts[i] || 0) !== (bParts[i] || 0)) {
          return (aParts[i] || 0) - (bParts[i] || 0);
        }
      }
      return 0;
    });

    logger.info(`Generated ${aggregateCriteria.length} aggregate criteria (sorted)`);

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
          status: 'REMEDIATED',
          issuesFound: j.issuesFound || 0,
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
