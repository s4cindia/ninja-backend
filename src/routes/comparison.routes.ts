import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { ComparisonService } from '../services/comparison';
import { ComparisonController } from '../controllers/comparison.controller';
import prisma from '../lib/prisma';
import { epubSpineService } from '../services/epub/epub-spine.service';

const router = Router({ mergeParams: true });

const comparisonService = new ComparisonService(prisma);
const comparisonController = new ComparisonController(comparisonService);

const asyncHandler = (fn: (req: Request, res: Response) => Promise<void | Response>) => {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
};

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
  '/changes/:changeId/visual',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, changeId } = req.params;
    const userId = ((req as unknown) as { user?: { id: string } }).user?.id;

    console.log(`[visual-comparison] Request for job ${jobId}, change ${changeId}`);

    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      console.error(`[visual-comparison] Job not found: ${jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    console.log(`[visual-comparison] Job found, calling getSpineItemForChange`);

    try {
      const visualData = await epubSpineService.getSpineItemForChange(jobId, changeId);
      console.log(`[visual-comparison] Visual data retrieved successfully`);
      res.json(visualData);
    } catch (error) {
      console.error(`[visual-comparison] Error getting visual data:`, error);
      console.error(`[visual-comparison] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
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
