import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { ComparisonService } from '../services/comparison';
import { ComparisonController } from '../controllers/comparison.controller';
import prisma from '../lib/prisma';

const router = Router({ mergeParams: true });

const comparisonService = new ComparisonService(prisma);
const comparisonController = new ComparisonController(comparisonService);

router.get('/', authenticate, comparisonController.getComparison);
router.get('/filter', authenticate, comparisonController.getChangesByFilter);
router.get('/changes/:changeId', authenticate, comparisonController.getChangeById);

export default router;
