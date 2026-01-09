import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { FileStatus, JobStatus, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';

/**
 * Extract file name from job input/output JSON data.
 * Checks output first (fileName, originalName), then input (originalName, fileName, filename).
 * @param job - The job object containing input and output JSON values
 * @returns The extracted file name or 'Unknown file' if not found
 */
function extractFileName(job: { input: Prisma.JsonValue; output: Prisma.JsonValue }): string {
  if (job.output && typeof job.output === 'object' && !Array.isArray(job.output)) {
    const output = job.output as Record<string, unknown>;
    if (typeof output.fileName === 'string') return output.fileName;
    if (typeof output.originalName === 'string') return output.originalName;
  }
  if (job.input && typeof job.input === 'object' && !Array.isArray(job.input)) {
    const input = job.input as Record<string, unknown>;
    if (typeof input.originalName === 'string') return input.originalName;
    if (typeof input.fileName === 'string') return input.fileName;
    if (typeof input.filename === 'string') return input.filename;
  }
  return 'Unknown file';
}

/**
 * Get dashboard statistics for the authenticated user's tenant.
 * Returns file counts by status and average compliance score.
 * @param req - The authenticated request containing user and tenant information
 * @param res - The Express response object
 * @returns JSON response with dashboard statistics including totalFiles, filesProcessed, filesPending, filesFailed, and averageComplianceScore
 */
export const getDashboardStats = async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.user?.tenantId;

  if (!tenantId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const [
      totalFiles,
      filesProcessed,
      filesPending,
      filesFailed,
      completedJobs
    ] = await Promise.all([
      prisma.file.count({
        where: { tenantId, deletedAt: null }
      }),
      prisma.file.count({
        where: { tenantId, deletedAt: null, status: FileStatus.PROCESSED }
      }),
      prisma.file.count({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: [FileStatus.UPLOADED, FileStatus.PROCESSING] }
        }
      }),
      prisma.file.count({
        where: { tenantId, deletedAt: null, status: FileStatus.ERROR }
      }),
      prisma.job.findMany({
        where: {
          tenantId,
          status: JobStatus.COMPLETED,
          type: 'EPUB_ACCESSIBILITY'
        },
        select: {
          output: true
        }
      })
    ]);

    let averageComplianceScore = 0;
    if (completedJobs.length > 0) {
      const scores = completedJobs
        .map(job => {
          const output = job.output as Prisma.JsonObject | null;
          return (output?.score as number) ?? (output?.complianceScore as number) ?? null;
        })
        .filter((s): s is number => s !== null);

      if (scores.length > 0) {
        averageComplianceScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      }
    }

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      success: true,
      data: {
        totalFiles,
        filesProcessed,
        filesPending,
        filesFailed,
        averageComplianceScore
      }
    });
  } catch (error) {
    logger.error(`Dashboard stats error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard stats'
    });
  }
};

interface ActivityItem {
  id: string;
  type: 'upload' | 'validation' | 'compliance' | 'remediation' | 'processing' | 'error' | 'alt-text' | 'metadata' | 'batch';
  description: string;
  timestamp: string;
  fileName?: string;
  status: string;
  score?: number;
}

/**
 * Format a job type enum value into a human-readable label.
 * @param type - The job type enum value (e.g., 'PDF_ACCESSIBILITY', 'EPUB_ACCESSIBILITY')
 * @returns A human-readable label for the job type
 */
function formatJobType(type: string): string {
  const labels: Record<string, string> = {
    'PDF_ACCESSIBILITY': 'PDF accessibility check',
    'EPUB_ACCESSIBILITY': 'EPUB accessibility check',
    'BATCH_VALIDATION': 'Batch remediation',
    'VPAT_GENERATION': 'VPAT generation',
    'ALT_TEXT_GENERATION': 'Alt text generation',
    'METADATA_EXTRACTION': 'Metadata extraction',
    'ACR_WORKFLOW': 'ACR workflow'
  };
  return labels[type] || type.replace(/_/g, ' ').toLowerCase();
}

/**
 * Map a job type and status to an activity type for dashboard display.
 * @param type - The job type enum value
 * @param status - The job status (e.g., 'COMPLETED', 'FAILED')
 * @returns The corresponding activity type for UI categorization
 */
function mapJobTypeToActivityType(type: string, status: string): ActivityItem['type'] {
  if (status === 'FAILED') return 'error';
  if (type === 'ALT_TEXT_GENERATION') return 'alt-text';
  if (type === 'METADATA_EXTRACTION') return 'metadata';
  if (type === 'BATCH_VALIDATION') return 'batch';
  if (type.includes('ACCESSIBILITY')) return 'validation';
  if (type === 'VPAT_GENERATION' || type === 'ACR_WORKFLOW') return 'compliance';
  return 'processing';
}

/**
 * Get recent activity feed for the authenticated user's tenant.
 * Returns a list of recent jobs with their type, status, file name, and optional score.
 * @param req - The authenticated request containing user and tenant information. Supports optional 'limit' query parameter (1-50, default 10)
 * @param res - The Express response object
 * @returns JSON response with array of activity items including id, type, description, timestamp, fileName, status, and score
 */
export const getDashboardActivity = async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.user?.tenantId;

  if (!tenantId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const limitParam = parseInt(req.query.limit as string) || 10;
    const limit = Math.min(Math.max(1, limitParam), 50);

    const recentJobs = await prisma.job.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        completedAt: true,
        input: true,
        output: true
      }
    });

    const activities: ActivityItem[] = recentJobs.map(job => {
      const output = job.output as Record<string, unknown> || {};
      const fileName = extractFileName(job);

      const typeLabel = formatJobType(job.type);
      const statusLabel = job.status.toLowerCase();
      const description = `${typeLabel} ${statusLabel}`;

      const score = job.status === 'COMPLETED' && job.type === 'EPUB_ACCESSIBILITY'
        ? ((output.score as number) ?? (output.complianceScore as number))
        : undefined;

      return {
        id: job.id,
        type: mapJobTypeToActivityType(job.type, job.status),
        description,
        timestamp: job.createdAt.toISOString(),
        fileName,
        status: job.status,
        score
      };
    });

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      success: true,
      data: activities
    });
  } catch (error) {
    logger.error(`Dashboard activity error: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard activity'
    });
  }
};
