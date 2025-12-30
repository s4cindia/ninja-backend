import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { FileStatus, JobStatus, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';

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
  type: 'upload' | 'validation' | 'compliance' | 'remediation' | 'processing' | 'error';
  description: string;
  timestamp: string;
  fileName?: string;
  status: string;
  score?: number;
}

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

function mapJobTypeToActivityType(type: string, status: string): ActivityItem['type'] {
  if (status === 'FAILED') return 'error';
  if (type === 'BATCH_VALIDATION') return 'remediation';
  if (type.includes('ACCESSIBILITY')) return 'validation';
  if (type === 'VPAT_GENERATION' || type === 'ACR_WORKFLOW') return 'compliance';
  return 'processing';
}

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
      const input = job.input as Record<string, unknown> || {};
      const output = job.output as Record<string, unknown> || {};

      let fileName = 'Unknown file';
      if (input.fileName) {
        fileName = String(input.fileName);
      } else if (input.originalName) {
        fileName = String(input.originalName);
      } else if (output.jobs && Array.isArray(output.jobs) && output.jobs[0]?.fileName) {
        fileName = String(output.jobs[0].fileName);
      }

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
