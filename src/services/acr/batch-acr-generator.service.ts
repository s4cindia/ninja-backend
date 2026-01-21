import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { remediationService } from '../epub/remediation.service';
import { batchRemediationService } from '../epub/batch-remediation.service';
import {
  BatchAcrOptions,
  BatchAcrGenerationResult,
  IndividualAcrGenerationResult,
  BatchNotFoundError,
  IncompleteBatchError,
  InvalidAcrOptionsError,
} from '../../types/batch-acr.types';

class BatchAcrGeneratorService {
  async generateBatchAcr(
    batchId: string,
    tenantId: string,
    userId: string,
    mode: 'individual' | 'aggregate',
    options?: BatchAcrOptions
  ): Promise<BatchAcrGenerationResult> {
    logger.info(`Starting batch ACR generation for batch ${batchId}, mode: ${mode}`);

    const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);
    if (!batch) {
      throw new BatchNotFoundError(batchId);
    }

    if (batch.status !== 'completed') {
      throw new IncompleteBatchError(batchId, batch.completedJobs, batch.totalJobs);
    }

    if (mode === 'aggregate') {
      if (!options) {
        throw new InvalidAcrOptionsError('Options are required for aggregate mode');
      }
      if (!options.edition || !options.batchName || !options.vendor || !options.contactEmail) {
        throw new InvalidAcrOptionsError('edition, batchName, vendor, and contactEmail are required for aggregate mode');
      }
      throw new Error('Aggregate mode not yet implemented');
    }

    return this.generateIndividualAcrs(batchId, tenantId, userId);
  }

  async generateIndividualAcrs(
    batchId: string,
    tenantId: string,
    userId: string
  ): Promise<IndividualAcrGenerationResult> {
    logger.info(`Generating individual ACRs for batch ${batchId}`);

    const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);
    if (!batch) {
      throw new BatchNotFoundError(batchId);
    }

    const successfulJobs = batch.jobs.filter(j => j.status === 'completed');

    if (successfulJobs.length === 0) {
      throw new Error('No successful jobs to generate ACRs from');
    }

    logger.info(`Found ${successfulJobs.length} successful jobs for ACR generation`);

    const acrWorkflowIds: string[] = [];
    const failedJobs: Array<{ jobId: string; error: string }> = [];

    for (const job of successfulJobs) {
      try {
        const result = await remediationService.transferToAcr(job.jobId);
        acrWorkflowIds.push(result.acrWorkflowId);
        logger.info(`Created ACR workflow ${result.acrWorkflowId} for job ${job.jobId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Failed to create ACR for job ${job.jobId}: ${errorMessage}`);
        failedJobs.push({ jobId: job.jobId, error: errorMessage });
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
    const batchJob = await prisma.job.findUnique({
      where: { id: batchId },
    });

    if (!batchJob || !batchJob.output) {
      throw new Error('Batch job not found');
    }

    const currentOutput = batchJob.output as Record<string, unknown>;
    const history = (currentOutput.acrGenerationHistory as Array<{
      mode: string;
      acrWorkflowIds: string[];
      generatedAt: string;
      generatedBy: string;
    }>) || [];

    const updatedOutput = {
      ...currentOutput,
      acrGenerated: metadata.acrGenerated,
      acrMode: metadata.acrMode,
      acrWorkflowIds: metadata.acrWorkflowIds,
      acrGeneratedAt: metadata.acrGeneratedAt,
      acrGenerationHistory: [
        ...history,
        {
          mode: metadata.acrMode,
          acrWorkflowIds: metadata.acrWorkflowIds,
          generatedAt: metadata.acrGeneratedAt,
          generatedBy: metadata.generatedBy,
        },
      ],
    };

    await prisma.job.update({
      where: { id: batchId },
      data: { output: updatedOutput as unknown as import('@prisma/client').Prisma.InputJsonValue },
    });

    logger.info(`Updated batch ${batchId} with ACR metadata`);
  }
}

export const batchAcrGeneratorService = new BatchAcrGeneratorService();
