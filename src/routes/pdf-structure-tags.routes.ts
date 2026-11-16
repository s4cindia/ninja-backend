/**
 * Structure Tag QC Review Routes
 *
 * Page-by-page structure-tag review -- GET the inventory for a page, PATCH
 * a single element's tag. Gated by the Full QC toggle at the controller
 * level (see pdf-structure-tags.controller.ts's own header comment).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorizeJob, authorizeJobForReview } from '../middleware/authorize-job.middleware';
import { pdfStructureTagsController } from '../controllers/pdf-structure-tags.controller';

const router = Router();

/**
 * GET /api/v1/pdf/:jobId/structure-tags?page=N
 * Every structure element on page N, with its current tag and bounding box.
 */
router.get(
  '/:jobId/structure-tags',
  authenticate,
  authorizeJobForReview,
  (req, res, next) => pdfStructureTagsController.listPage(req, res, next)
);

/**
 * PATCH /api/v1/pdf/:jobId/structure-tags/:elementId
 * Retags a single structure element. Body: { newTag: string }.
 */
router.patch(
  '/:jobId/structure-tags/:elementId',
  authenticate,
  authorizeJob,
  (req, res, next) => pdfStructureTagsController.retag(req, res, next)
);

export default router;
