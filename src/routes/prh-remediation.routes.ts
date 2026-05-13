import { Router } from 'express';
import { prhRemediationController } from '../controllers/prh-remediation.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

/**
 * PRH UK remediation routes (P5/PR1).
 * Mounted under `/api/v1/jobs/:jobId/prh-remediation/...`.
 *
 * Each route checks tenant ownership of the job inside the controller
 * — the route-level middleware authenticates the caller, the
 * controller checks they're allowed to see THIS job.
 */

/**
 * POST /api/v1/jobs/:jobId/prh-remediation/boilerplate/draft
 * Returns the per-imprint boilerplate snippets the operator can
 * choose to inject. Read-only — never mutates the EPUB.
 */
router.post(
  '/:jobId/prh-remediation/boilerplate/draft',
  authenticate,
  prhRemediationController.getBoilerplateDraft.bind(prhRemediationController),
);

/**
 * POST /api/v1/jobs/:jobId/prh-remediation/boilerplate/apply
 * Body: { approvedCodes: string[], overrides?: { [code]: html } }
 * Injects approved snippets into the copyright XHTML and saves the
 * remediated EPUB via fileStorageService.saveRemediatedFile.
 */
router.post(
  '/:jobId/prh-remediation/boilerplate/apply',
  authenticate,
  prhRemediationController.applyBoilerplate.bind(prhRemediationController),
);

export default router;
