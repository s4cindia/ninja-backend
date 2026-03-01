/**
 * Integrity Check Service
 *
 * Orchestrates integrity checks for a document using Claude AI.
 * Sends document content with structural context to the AI and lets
 * it identify real issues, reducing false positives from rule-based checks.
 */

import { Prisma, IntegrityCheckType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { aiIntegrityCheck, VALID_CHECK_TYPES } from './checks/ai-integrity.check';

export interface CheckResult {
  checkType: string;
  issues: Array<{
    checkType: string;
    severity: 'ERROR' | 'WARNING' | 'SUGGESTION';
    title: string;
    description: string;
    startOffset?: number;
    endOffset?: number;
    originalText?: string;
    expectedValue?: string;
    actualValue?: string;
    suggestedFix?: string;
    context?: string;
  }>;
  metadata: Record<string, unknown>;
}

// Export check types array for request validation in controllers
export const ALL_CHECK_TYPES = Array.from(VALID_CHECK_TYPES);

/**
 * Start an integrity check job.
 */
async function startCheck(
  tenantId: string,
  documentId: string,
  checkTypes?: string[]
): Promise<{ jobId: string; created: boolean; status: string }> {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) throw AppError.notFound('Document not found');

  const selectedTypes = (checkTypes && checkTypes.length > 0
    ? checkTypes.filter(t => VALID_CHECK_TYPES.has(t))
    : ALL_CHECK_TYPES) as IntegrityCheckType[];

  // Atomically check concurrency + duplicate jobs inside a transaction
  const MAX_CONCURRENT_JOBS = 2;
  const { job, isNew } = await prisma.$transaction(async (tx) => {
    // Per-tenant concurrency cap
    const activeJobCount = await tx.integrityCheckJob.count({
      where: { tenantId, status: { in: ['QUEUED', 'PROCESSING'] } },
    });
    if (activeJobCount >= MAX_CONCURRENT_JOBS) {
      throw AppError.badRequest(`Maximum ${MAX_CONCURRENT_JOBS} concurrent integrity checks allowed per tenant`);
    }

    const existingJob = await tx.integrityCheckJob.findFirst({
      where: { documentId, tenantId, status: { in: ['QUEUED', 'PROCESSING'] } },
      select: { id: true, status: true },
    });
    if (existingJob) return { job: existingJob, isNew: false };

    const created = await tx.integrityCheckJob.create({
      data: {
        tenantId,
        documentId,
        status: 'QUEUED',
        checkTypes: selectedTypes,
        progress: 0,
        totalChecks: selectedTypes.length,
      },
    });
    return { job: created, isNew: true };
  });

  // Only execute if this is a newly created job (not a duplicate)
  if (isNew) {
    executeCheck(job.id, tenantId, documentId, selectedTypes).catch(err => {
      logger.error(`[IntegrityCheck] Job ${job.id} failed:`, err);
    });
  }

  return {
    jobId: job.id,
    created: isNew,
    status: isNew ? 'QUEUED' : (job as { status?: string }).status || 'PROCESSING',
  };
}

/**
 * Execute the integrity check (called asynchronously).
 *
 * Tenant scoping: documentId was already verified against tenantId in startCheck()
 * before this function is called. Since documentId is a UUID (unguessable), we scope
 * the document fetch by tenantId as defense-in-depth rather than strictly for authz.
 */
async function executeCheck(
  jobId: string,
  tenantId: string,
  documentId: string,
  checkTypes: string[]
): Promise<void> {
  try {
    await prisma.integrityCheckJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    // Get document content and content type (tenant-scoped for defense-in-depth)
    const [docContent, editorialDoc] = await Promise.all([
      prisma.editorialDocumentContent.findFirst({
        where: { documentId, document: { tenantId } },
        select: { fullText: true, fullHtml: true },
      }),
      prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { contentType: true },
      }),
    ]);

    if (!docContent?.fullText) {
      await prisma.integrityCheckJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', metadata: { error: 'No document content found' } },
      });
      return;
    }

    const text = docContent.fullText;
    const html = docContent.fullHtml || '';
    const contentType = editorialDoc?.contentType || 'UNKNOWN';

    // Run AI-based integrity check with progress tracking
    // Throttle DB writes: only persist when progress changes by >=5% to avoid excessive updates
    let lastPersistedProgress = 0;
    const allIssues = await aiIntegrityCheck(text, html, contentType, {
      checkTypes,
      onProgress: async (pct) => {
        if (pct - lastPersistedProgress >= 5 || pct >= 100) {
          lastPersistedProgress = pct;
          await prisma.integrityCheckJob.update({
            where: { id: jobId },
            data: { progress: pct },
          });
        }
      },
    });

    // Map issues for batch insert
    const allIssueData: Prisma.IntegrityIssueCreateManyInput[] = allIssues.map(issue => ({
      documentId,
      jobId,
      checkType: issue.checkType as Prisma.IntegrityIssueCreateManyInput['checkType'],
      severity: issue.severity as Prisma.IntegrityIssueCreateManyInput['severity'],
      title: issue.title,
      description: issue.description,
      startOffset: issue.startOffset ?? null,
      endOffset: issue.endOffset ?? null,
      originalText: issue.originalText ?? null,
      expectedValue: issue.expectedValue ?? null,
      actualValue: issue.actualValue ?? null,
      suggestedFix: issue.suggestedFix ?? null,
      context: issue.context ?? null,
      status: 'PENDING',
    }));

    // Batch insert issues
    if (allIssueData.length > 0) {
      await prisma.integrityIssue.createMany({
        data: allIssueData,
      });
    }

    await prisma.integrityCheckJob.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        issuesFound: allIssues.length,
        completedAt: new Date(),
      },
    });

    logger.info(`[IntegrityCheck] Job ${jobId} completed: ${allIssues.length} issues found`);
  } catch (error) {
    logger.error(`[IntegrityCheck] Job ${jobId} failed:`, error);
    await prisma.integrityCheckJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
      },
    }).catch((updateErr) => {
      logger.error(`[IntegrityCheck] Failed to update job ${jobId} status to FAILED:`, updateErr);
    });
  }
}

/**
 * Get job status (tenant-scoped).
 */
async function getJobStatus(jobId: string, tenantId: string) {
  return prisma.integrityCheckJob.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true,
      status: true,
      progress: true,
      totalChecks: true,
      issuesFound: true,
      checkTypes: true,
      startedAt: true,
      completedAt: true,
      metadata: true,
    },
  });
}

/** Find the latest completed integrity check job for a document. */
async function getLatestJobId(documentId: string): Promise<string | null> {
  const latestJob = await prisma.integrityCheckJob.findFirst({
    where: { documentId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return latestJob?.id ?? null;
}

/**
 * Get issues for a document with filtering and pagination.
 * Only returns issues from the latest completed check job.
 */
async function getIssues(
  documentId: string,
  tenantId: string,
  options?: {
    checkType?: string;
    severity?: string;
    status?: string;
    page?: number;
    limit?: number;
  }
) {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) return { issues: [], total: 0, page: 1, limit: 50, totalPages: 0 };

  const page = options?.page ?? 1;
  const limit = options?.limit ?? 50;
  const skip = (page - 1) * limit;

  const latestJobId = await getLatestJobId(documentId);
  if (!latestJobId) return { issues: [], total: 0, page, limit, totalPages: 0 };

  const where: Prisma.IntegrityIssueWhereInput = { documentId, jobId: latestJobId };
  if (options?.checkType) where.checkType = options.checkType as Prisma.EnumIntegrityCheckTypeFilter;
  if (options?.severity) where.severity = options.severity as Prisma.EnumStyleSeverityFilter;
  if (options?.status) where.status = options.status as Prisma.EnumViolationStatusFilter;

  const [issues, total] = await Promise.all([
    prisma.integrityIssue.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.integrityIssue.count({
      where,
    }),
  ]);

  return { issues, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Get summary grouped by check type.
 * Only includes issues from the latest completed check job.
 */
async function getSummary(documentId: string, tenantId: string) {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) return {};

  const latestJobId = await getLatestJobId(documentId);
  if (!latestJobId) return {};

  // Use groupBy aggregation instead of loading all issues
  const groups = await prisma.integrityIssue.groupBy({
    by: ['checkType', 'severity', 'status'],
    where: { documentId, jobId: latestJobId },
    _count: true,
  });

  const summary: Record<string, { total: number; errors: number; warnings: number; suggestions: number; pending: number; fixed: number; ignored: number }> = {};

  for (const g of groups) {
    const key = g.checkType;
    if (!summary[key]) {
      summary[key] = { total: 0, errors: 0, warnings: 0, suggestions: 0, pending: 0, fixed: 0, ignored: 0 };
    }
    summary[key].total += g._count;
    if (g.severity === 'ERROR') summary[key].errors += g._count;
    else if (g.severity === 'WARNING') summary[key].warnings += g._count;
    else summary[key].suggestions += g._count;
    if (g.status === 'PENDING') summary[key].pending += g._count;
    else if (g.status === 'FIXED' || g.status === 'AUTO_FIXED') summary[key].fixed += g._count;
    else if (g.status === 'IGNORED') summary[key].ignored += g._count;
  }

  return summary;
}

/**
 * Apply a suggested fix to an issue (tenant-scoped).
 * Uses a transaction to atomically verify ownership and update.
 */
async function applyFix(issueId: string, tenantId: string, resolvedBy: string) {
  return prisma.$transaction(async (tx) => {
    const issue = await tx.integrityIssue.findFirst({
      where: { id: issueId, document: { tenantId } },
      select: { id: true },
    });
    if (!issue) throw AppError.notFound('Integrity issue not found');

    return tx.integrityIssue.update({
      where: { id: issueId },
      data: {
        status: 'FIXED',
        resolvedAt: new Date(),
        resolvedBy,
        resolution: 'Applied suggested fix',
      },
      select: {
        id: true,
        checkType: true,
        severity: true,
        title: true,
        status: true,
        resolvedAt: true,
        resolvedBy: true,
        resolution: true,
      },
    });
  });
}

/**
 * Ignore an issue (tenant-scoped).
 * Uses a transaction to atomically verify ownership and update.
 */
async function ignoreIssue(issueId: string, tenantId: string, resolvedBy: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    const issue = await tx.integrityIssue.findFirst({
      where: { id: issueId, document: { tenantId } },
      select: { id: true },
    });
    if (!issue) throw AppError.notFound('Integrity issue not found');

    return tx.integrityIssue.update({
      where: { id: issueId },
      data: {
        status: 'IGNORED',
        resolvedAt: new Date(),
        resolvedBy,
        resolution: reason || 'Ignored by user',
      },
      select: {
        id: true,
        checkType: true,
        severity: true,
        title: true,
        status: true,
        resolvedAt: true,
        resolvedBy: true,
        resolution: true,
      },
    });
  });
}

/**
 * Bulk action on multiple issues (tenant-scoped).
 * Logs a security warning if some IDs were skipped (potential cross-tenant IDOR probe).
 */
async function bulkAction(
  issueIds: string[],
  action: 'fix' | 'ignore',
  tenantId: string,
  resolvedBy: string
) {
  const status = action === 'fix' ? 'FIXED' : 'IGNORED';
  const result = await prisma.integrityIssue.updateMany({
    where: { id: { in: issueIds }, document: { tenantId } },
    data: {
      status: status as 'FIXED' | 'IGNORED',
      resolvedAt: new Date(),
      resolvedBy,
      resolution: action === 'fix' ? 'Bulk fix applied' : 'Bulk ignored',
    },
  });
  const skipped = issueIds.length - result.count;
  if (skipped > 0) {
    logger.warn(
      `[IntegrityCheck] bulkAction: ${skipped}/${issueIds.length} IDs skipped for tenant ${tenantId} — possible cross-tenant or stale IDs`
    );
  }
  return { updated: result.count, requested: issueIds.length, skipped };
}

/**
 * Mark stale PROCESSING/QUEUED jobs as FAILED.
 * Call on server startup to recover from crashes.
 */
const DEFAULT_JOB_TIMEOUT_MS = parseInt(process.env.INTEGRITY_JOB_TIMEOUT_MS || '', 10) || 30 * 60 * 1000;
async function cleanupStaleJobs(maxAgeMs = DEFAULT_JOB_TIMEOUT_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await prisma.integrityCheckJob.updateMany({
    where: {
      status: { in: ['QUEUED', 'PROCESSING'] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: 'FAILED',
      metadata: { error: 'Job timed out (stale cleanup)' },
    },
  });
  if (result.count > 0) {
    logger.info(`[IntegrityCheck] Cleaned up ${result.count} stale job(s)`);
  }
  return result.count;
}

export const integrityCheckService = {
  startCheck,
  getJobStatus,
  getIssues,
  getSummary,
  applyFix,
  ignoreIssue,
  bulkAction,
  cleanupStaleJobs,
};
