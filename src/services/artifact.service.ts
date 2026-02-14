import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';

export type ArtifactType = 'audit_result' | 'remediation_plan' | 'comparison_report' | 'auto_remediation' | 'export_metadata';

export interface ArtifactInput {
  jobId: string;
  fileId?: string;
  type: ArtifactType;
  name?: string;
  data: Prisma.InputJsonValue;
  size?: number;
}

class ArtifactService {
  async saveArtifact(input: ArtifactInput) {
    const existing = await prisma.artifact.findFirst({
      where: { jobId: input.jobId, type: input.type },
    });

    if (existing) {
      const artifact = await prisma.artifact.update({
        where: { id: existing.id },
        data: {
          data: input.data,
          size: input.size,
          name: input.name,
        },
      });
      logger.info(`Artifact updated: ${input.type} for job ${input.jobId}`);
      return artifact;
    }

    const artifact = await prisma.artifact.create({
      data: {
        jobId: input.jobId,
        fileId: input.fileId,
        type: input.type,
        name: input.name || this.getDefaultName(input.type),
        data: input.data,
        size: input.size,
      },
    });
    logger.info(`Artifact created: ${input.type} for job ${input.jobId}`);
    return artifact;
  }

  private getDefaultName(type: string): string {
    const names: Record<string, string> = {
      audit_result: 'Accessibility Audit Results',
      remediation_plan: 'Remediation Plan',
      comparison_report: 'Before/After Comparison',
      auto_remediation: 'Auto-Remediation Results',
      export_metadata: 'Export Metadata',
    };
    return names[type] || type;
  }

  async getArtifact(jobId: string, type: string) {
    return prisma.artifact.findFirst({
      where: { jobId, type },
    });
  }

  async getArtifactsByJob(jobId: string) {
    return prisma.artifact.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getArtifactsByFile(fileId: string) {
    return prisma.artifact.findMany({
      where: { fileId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteArtifactsByJob(jobId: string) {
    const result = await prisma.artifact.deleteMany({
      where: { jobId },
    });
    logger.info(`Deleted ${result.count} artifacts for job ${jobId}`);
    return result.count;
  }
}

export const artifactService = new ArtifactService();
