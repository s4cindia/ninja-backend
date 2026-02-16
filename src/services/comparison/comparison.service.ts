import { PrismaClient, ChangeStatus, RemediationChange } from '@prisma/client';
import {
  ComparisonData,
  ComparisonFilters,
  ComparisonSummary,
  ChangeSummaryByCategory,
  CreateChangeData,
  PaginationInfo,
} from '../../types/comparison.types';
import { logger } from '../../lib/logger';

function decodeHtmlEntities(str: string | null): string | null {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function decodeChangeContent<T extends { beforeContent?: string | null; afterContent?: string | null }>(change: T): T {
  return {
    ...change,
    beforeContent: decodeHtmlEntities(change.beforeContent ?? null),
    afterContent: decodeHtmlEntities(change.afterContent ?? null),
  };
}

export class ComparisonService {
  constructor(private prisma: PrismaClient) {}

  async getComparison(
    jobId: string,
    pagination?: { page?: number; limit?: number }
  ): Promise<ComparisonData> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        artifacts: true,
      },
    });

    if (!job) {
      throw new Error('Job not found');
    }

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 50;
    const skip = (page - 1) * limit;

    const [changes, totalChanges] = await Promise.all([
      this.prisma.remediationChange.findMany({
        where: { jobId },
        orderBy: { changeNumber: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.remediationChange.count({ where: { jobId } }),
    ]);

    const allChanges = await this.prisma.remediationChange.findMany({
      where: { jobId },
      select: { status: true, changeType: true, severity: true, wcagCriteria: true },
    });

    const summary = this.calculateSummary(allChanges);
    const byType = this.groupByField(allChanges, 'changeType');
    const bySeverity = this.groupByField(allChanges, 'severity');
    const byWcag = this.groupByField(allChanges, 'wcagCriteria');

    const paginationInfo: PaginationInfo = {
      page,
      limit,
      total: totalChanges,
      pages: Math.ceil(totalChanges / limit),
    };

    const input = job.input as Record<string, any>;
    const fileName = input?.fileName || input?.filename || 'Unknown';

    return {
      jobId,
      fileName,
      originalFileId: input?.originalFileId,
      remediatedFileId: input?.remediatedFileId,
      auditedAt: job.startedAt || undefined,
      remediatedAt: job.completedAt || undefined,
      summary,
      byType,
      bySeverity,
      byWcag,
      pagination: paginationInfo,
      changes: changes.map(decodeChangeContent),
    };
  }

  async getChangeById(jobId: string, changeId: string): Promise<RemediationChange> {
    const change = await this.prisma.remediationChange.findUnique({
      where: { id: changeId },
    });

    if (!change) {
      throw new Error('Change not found');
    }

    if (change.jobId !== jobId) {
      throw new Error('Change does not belong to this job');
    }

    return decodeChangeContent(change);
  }

  async getChangesByFilter(
    jobId: string,
    filters: ComparisonFilters
  ): Promise<ComparisonData> {
    const where: Record<string, unknown> = { jobId };

    if (filters.changeType) {
      where.changeType = filters.changeType;
    }
    if (filters.severity) {
      where.severity = filters.severity;
    }
    if (filters.status) {
      where.status = filters.status as ChangeStatus;
    }
    if (filters.wcagCriteria) {
      where.wcagCriteria = filters.wcagCriteria;
    }
    if (filters.filePath) {
      where.filePath = { contains: filters.filePath, mode: 'insensitive' };
    }
    if (filters.search) {
      where.OR = [
        { filePath: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const skip = (page - 1) * limit;

    const [changes, totalChanges] = await Promise.all([
      this.prisma.remediationChange.findMany({
        where,
        orderBy: { changeNumber: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.remediationChange.count({ where }),
    ]);

    const allFilteredChanges = await this.prisma.remediationChange.findMany({
      where,
      select: { status: true, changeType: true, severity: true, wcagCriteria: true },
    });

    const summary = this.calculateSummary(allFilteredChanges);
    const byType = this.groupByField(allFilteredChanges, 'changeType');
    const bySeverity = this.groupByField(allFilteredChanges, 'severity');
    const byWcag = this.groupByField(allFilteredChanges, 'wcagCriteria');

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { input: true },
    });

    const input = (job?.input as Record<string, any>) || {};
    const fileName = input?.fileName || input?.filename || 'Unknown';

    return {
      jobId,
      fileName,
      summary,
      byType,
      bySeverity,
      byWcag,
      pagination: {
        page,
        limit,
        total: totalChanges,
        pages: Math.ceil(totalChanges / limit),
      },
      changes: changes.map(decodeChangeContent),
    };
  }

  async logChange(data: CreateChangeData, retries = 3): Promise<RemediationChange> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const change = await this.prisma.$transaction(async (tx) => {
          const maxChange = await tx.remediationChange.findFirst({
            where: { jobId: data.jobId },
            orderBy: { changeNumber: 'desc' },
            select: { changeNumber: true },
          });

          const changeNumber = (maxChange?.changeNumber || 0) + 1;

          return await tx.remediationChange.create({
            data: {
              jobId: data.jobId,
              taskId: data.taskId,
              changeNumber,
              issueId: data.issueId,
              ruleId: data.ruleId,
              filePath: data.filePath,
              elementXPath: data.elementXPath,
              lineNumber: data.lineNumber,
              changeType: data.changeType,
              description: data.description,
              beforeContent: data.beforeContent,
              afterContent: data.afterContent,
              contextBefore: data.contextBefore,
              contextAfter: data.contextAfter,
              severity: data.severity,
              wcagCriteria: data.wcagCriteria,
              wcagLevel: data.wcagLevel,
              appliedBy: data.appliedBy,
              status: 'APPLIED',
            },
          });
        });

        return change;
      } catch (error) {
        const isUniqueConstraintViolation = 
          error instanceof Error && 
          (error.message.includes('Unique constraint') || error.message.includes('P2002'));
        
        if (isUniqueConstraintViolation && attempt < retries) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Failed to log change after maximum retries');
  }

  async updateChangeStatus(
    changeId: string,
    status: ChangeStatus
  ): Promise<RemediationChange> {
    const change = await this.prisma.remediationChange.update({
      where: { id: changeId },
      data: { status },
    });

    return change;
  }

  /**
   * Safely log changes with error handling
   *
   * This method wraps logChange() calls with try-catch to prevent logging failures
   * from breaking remediation workflows. Failed logs are logged but don't throw errors.
   *
   * @param changes - Array of change data to log
   * @param context - Logging context (jobId, source identifier)
   * @returns Number of successfully logged changes
   * @example
   * const successCount = await comparisonService.logChangesSafely(
   *   [{ jobId, changeType, description, ... }],
   *   { jobId: 'job-123', source: 'PDF-AutoFix' }
   * );
   * logger.info(`Logged ${successCount}/5 changes`);
   */
  async logChangesSafely(
    changes: CreateChangeData[],
    context: { jobId: string; source: string }
  ): Promise<number> {
    let successCount = 0;

    for (const changeData of changes) {
      try {
        await this.logChange(changeData);
        successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          `[${context.source}] Failed to log change for job ${context.jobId}`,
          {
            changeType: changeData.changeType,
            error: errorMessage,
          }
        );
        // Continue processing remaining changes
      }
    }

    if (successCount < changes.length) {
      logger.warn(
        `[${context.source}] Logged ${successCount}/${changes.length} changes for job ${context.jobId}`
      );
    } else {
      logger.info(
        `[${context.source}] Successfully logged ${successCount} changes for job ${context.jobId}`
      );
    }

    return successCount;
  }

  private calculateSummary(
    changes: { status: ChangeStatus }[]
  ): ComparisonSummary {
    const summary: ComparisonSummary = {
      totalChanges: changes.length,
      applied: 0,
      rejected: 0,
      skipped: 0,
      failed: 0,
    };

    for (const change of changes) {
      switch (change.status) {
        case 'APPLIED':
          summary.applied++;
          break;
        case 'REJECTED':
          summary.rejected++;
          break;
        case 'SKIPPED':
          summary.skipped++;
          break;
        case 'FAILED':
          summary.failed++;
          break;
        case 'REVERTED':
          summary.rejected++;
          break;
      }
    }

    return summary;
  }

  private groupByField(
    changes: { status: ChangeStatus; changeType: string; severity: string | null; wcagCriteria: string | null }[],
    field: 'changeType' | 'severity' | 'wcagCriteria'
  ): Record<string, ChangeSummaryByCategory> {
    const grouped: Record<string, ChangeSummaryByCategory> = {};

    for (const change of changes) {
      const key = change[field] || 'unknown';
      if (!grouped[key]) {
        grouped[key] = { count: 0, applied: 0, rejected: 0, skipped: 0, failed: 0 };
      }
      grouped[key].count++;
      
      switch (change.status) {
        case 'APPLIED':
          grouped[key].applied++;
          break;
        case 'REJECTED':
        case 'REVERTED':
          grouped[key].rejected!++;
          break;
        case 'SKIPPED':
          grouped[key].skipped!++;
          break;
        case 'FAILED':
          grouped[key].failed!++;
          break;
      }
    }

    return grouped;
  }
}
