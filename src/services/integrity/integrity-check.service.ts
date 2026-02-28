/**
 * Integrity Check Service
 *
 * Orchestrates integrity checks for a document using Claude AI.
 * Sends document content with structural context to the AI and lets
 * it identify real issues, reducing false positives from rule-based checks.
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { aiIntegrityCheck } from './checks/ai-integrity.check';

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

const ALL_CHECK_TYPES = [
  'FIGURE_REF',
  'TABLE_REF',
  'EQUATION_REF',
  'BOX_REF',
  'CITATION_REF',
  'SECTION_NUMBERING',
  'FIGURE_NUMBERING',
  'TABLE_NUMBERING',
  'EQUATION_NUMBERING',
  'UNIT_CONSISTENCY',
  'ABBREVIATION',
  'CROSS_REF',
  'DUPLICATE_CONTENT',
  'HEADING_HIERARCHY',
  'ALT_TEXT',
  'TABLE_STRUCTURE',
  'FOOTNOTE_REF',
  'TOC_CONSISTENCY',
  'ISBN_FORMAT',
  'DOI_FORMAT',
  'TERMINOLOGY',
];

/**
 * Start an integrity check job.
 */
async function startCheck(
  tenantId: string,
  documentId: string,
  checkTypes?: string[]
): Promise<{ jobId: string }> {
  // Verify document belongs to tenant
  const doc = await prisma.editorialDocument.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true },
  });
  if (!doc) throw AppError.notFound('Document not found');

  const selectedTypes = checkTypes && checkTypes.length > 0
    ? checkTypes.filter(t => ALL_CHECK_TYPES.includes(t))
    : ALL_CHECK_TYPES;

  // Prevent duplicate concurrent jobs for the same document/tenant
  const existingJob = await prisma.integrityCheckJob.findFirst({
    where: { documentId, tenantId, status: { in: ['QUEUED', 'PROCESSING'] } },
    select: { id: true },
  });
  if (existingJob) {
    return { jobId: existingJob.id };
  }

  const job = await prisma.integrityCheckJob.create({
    data: {
      tenantId,
      documentId,
      status: 'QUEUED',
      checkTypes: selectedTypes,
      progress: 0,
      totalChecks: selectedTypes.length,
    },
  });

  // Execute asynchronously
  executeCheck(job.id, tenantId, documentId, selectedTypes).catch(err => {
    logger.error(`[IntegrityCheck] Job ${job.id} failed:`, err);
  });

  return { jobId: job.id };
}

/**
 * Execute the integrity check (called asynchronously).
 */
async function executeCheck(
  jobId: string,
  _tenantId: string,
  documentId: string,
  checkTypes: string[]
): Promise<void> {
  try {
    await prisma.integrityCheckJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    // Get document content and content type
    const [docContent, editorialDoc] = await Promise.all([
      prisma.editorialDocumentContent.findUnique({
        where: { documentId },
        select: { fullText: true, fullHtml: true },
      }),
      prisma.editorialDocument.findUnique({
        where: { id: documentId },
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
    const allIssues = await aiIntegrityCheck(text, html, contentType, {
      checkTypes,
      onProgress: async (pct) => {
        await prisma.integrityCheckJob.update({
          where: { id: jobId },
          data: { progress: pct, issuesFound: 0 },
        });
      },
    });

    // Map issues for batch insert
    const allIssueData = allIssues.map(issue => ({
      documentId,
      jobId,
      checkType: issue.checkType as string,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      startOffset: issue.startOffset ?? null,
      endOffset: issue.endOffset ?? null,
      originalText: issue.originalText ?? null,
      expectedValue: issue.expectedValue ?? null,
      actualValue: issue.actualValue ?? null,
      suggestedFix: issue.suggestedFix ?? null,
      context: issue.context ?? null,
      status: 'PENDING' as const,
    }));

    // Batch insert issues
    if (allIssueData.length > 0) {
      await prisma.integrityIssue.createMany({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: allIssueData as any,
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
    }).catch(() => {});
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

  const where: Record<string, unknown> = { documentId, jobId: latestJobId };
  if (options?.checkType) where.checkType = options.checkType;
  if (options?.severity) where.severity = options.severity;
  if (options?.status) where.status = options.status;

  const [issues, total] = await Promise.all([
    prisma.integrityIssue.findMany({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.integrityIssue.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
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

  const summary: Record<string, { total: number; errors: number; warnings: number; suggestions: number; pending: number; fixed: number }> = {};

  for (const g of groups) {
    const key = g.checkType;
    if (!summary[key]) {
      summary[key] = { total: 0, errors: 0, warnings: 0, suggestions: 0, pending: 0, fixed: 0 };
    }
    summary[key].total += g._count;
    if (g.severity === 'ERROR') summary[key].errors += g._count;
    else if (g.severity === 'WARNING') summary[key].warnings += g._count;
    else summary[key].suggestions += g._count;
    if (g.status === 'PENDING') summary[key].pending += g._count;
    else if (g.status === 'FIXED' || g.status === 'AUTO_FIXED') summary[key].fixed += g._count;
  }

  return summary;
}

/**
 * Apply a suggested fix to an issue (tenant-scoped).
 */
async function applyFix(issueId: string, tenantId: string, resolvedBy: string) {
  const issue = await prisma.integrityIssue.findFirst({
    where: { id: issueId, document: { tenantId } },
    select: { id: true },
  });
  if (!issue) throw AppError.notFound('Integrity issue not found');

  return prisma.integrityIssue.update({
    where: { id: issueId },
    data: {
      status: 'FIXED',
      resolvedAt: new Date(),
      resolvedBy,
      resolution: 'Applied suggested fix',
    },
  });
}

/**
 * Ignore an issue (tenant-scoped).
 */
async function ignoreIssue(issueId: string, tenantId: string, resolvedBy: string, reason?: string) {
  const issue = await prisma.integrityIssue.findFirst({
    where: { id: issueId, document: { tenantId } },
    select: { id: true },
  });
  if (!issue) throw AppError.notFound('Integrity issue not found');

  return prisma.integrityIssue.update({
    where: { id: issueId },
    data: {
      status: 'IGNORED',
      resolvedAt: new Date(),
      resolvedBy,
      resolution: reason || 'Ignored by user',
    },
  });
}

/**
 * Bulk action on multiple issues (tenant-scoped).
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
  return { updated: result.count };
}

export const integrityCheckService = {
  startCheck,
  getJobStatus,
  getIssues,
  getSummary,
  applyFix,
  ignoreIssue,
  bulkAction,
};
