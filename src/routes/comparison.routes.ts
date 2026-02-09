import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { ComparisonService } from '../services/comparison';
import { ComparisonController } from '../controllers/comparison.controller';
import prisma from '../lib/prisma';
import { epubSpineService } from '../services/epub/epub-spine.service';
import { logger } from '../lib/logger';

const router = Router({ mergeParams: true });

const comparisonService = new ComparisonService(prisma);
const comparisonController = new ComparisonController(comparisonService);

const asyncHandler = (fn: (req: Request, res: Response) => Promise<void | Response>) => {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
};

import fs from 'fs';
import path from 'path';

router.get(
  '/debug',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;

    const job = await prisma.job.findUnique({
      where: { id: jobId }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const input = job.input as Record<string, unknown> | null;
    const storagePath = process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage';
    const jobStoragePath = path.join(storagePath, jobId);
    const remediatedPath = path.join(jobStoragePath, 'remediated');

    let filesOnDisk: string[] = [];
    let remediatedFilesOnDisk: string[] = [];

    try {
      filesOnDisk = fs.existsSync(jobStoragePath) ? fs.readdirSync(jobStoragePath) : [];
    } catch { filesOnDisk = []; }

    try {
      remediatedFilesOnDisk = fs.existsSync(remediatedPath) ? fs.readdirSync(remediatedPath) : [];
    } catch { remediatedFilesOnDisk = []; }

    res.json({
      jobId: job.id,
      status: job.status,
      type: job.type,
      input: input,
      storagePath: jobStoragePath,
      filesOnDisk,
      remediatedPath,
      remediatedFilesOnDisk
    });
  })
);

router.get(
  '/spine',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const userId = ((req as unknown) as { user?: { id: string } }).user?.id;

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const spineItems = await epubSpineService.getSpineItems(jobId);
    res.json(spineItems);
  })
);

router.get(
  '/changes/:changeId/debug',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, changeId } = req.params;
    const debugInfo = await epubSpineService.debugChangeToSpineMapping(jobId, changeId);
    res.json(debugInfo);
  })
);

router.get(
  '/all-changes',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;

    const changes = await prisma.remediationChange.findMany({
      where: { jobId },
      select: {
        id: true,
        changeNumber: true,
        changeType: true,
        description: true,
        filePath: true,
        status: true,
        appliedAt: true,
        severity: true,
        elementXPath: true
      },
      orderBy: { changeNumber: 'asc' }
    });

    res.json({
      totalChanges: changes.length,
      changesByType: changes.reduce((acc, c) => {
        acc[c.changeType] = (acc[c.changeType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      changesByStatus: changes.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      changes
    });
  })
);

router.get(
  '/changes/:changeId/visual',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, changeId } = req.params;
    const userId = ((req as unknown) as { user?: { id: string } }).user?.id;

    logger.debug(`[visual-comparison] Request for job ${jobId}, change ${changeId}`);

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      logger.warn(`[visual-comparison] Job not found: ${jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    logger.debug(`[visual-comparison] Job found, calling getSpineItemForChange`);

    try {
      const visualData = await epubSpineService.getSpineItemForChange(jobId, changeId);
      logger.debug(`[visual-comparison] Visual data retrieved successfully`);
      res.json(visualData);
    } catch (error) {
      logger.error(`[visual-comparison] Error getting visual data: ${error}`);
      logger.error(`[visual-comparison] Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
      throw error;
    }
  })
);

router.get(
  '/spine/:spineItemId',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, spineItemId } = req.params;
    const { version } = req.query;
    const userId = ((req as unknown) as { user?: { id: string } }).user?.id;

    if (version !== 'original' && version !== 'remediated') {
      return res.status(400).json({ error: 'version must be "original" or "remediated"' });
    }

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const content = await epubSpineService.getSpineItemContent(
      jobId,
      spineItemId,
      version as 'original' | 'remediated'
    );
    res.json(content);
  })
);

router.get('/', authenticate, comparisonController.getComparison);
router.get('/filter', authenticate, comparisonController.getChangesByFilter);
router.get('/changes/:changeId', authenticate, comparisonController.getChangeById);

export default router;
