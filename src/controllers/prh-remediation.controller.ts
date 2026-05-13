/**
 * PRH UK remediation controller (P5/PR1).
 *
 * Two-phase boilerplate injection workflow:
 *
 *   POST /api/v1/jobs/:jobId/prh-remediation/boilerplate/draft
 *     Returns the per-imprint boilerplate snippets the operator can
 *     choose to inject. Snippets with `__MISSING_*__` placeholders
 *     flag fields the operator must fill in before applying.
 *
 *   POST /api/v1/jobs/:jobId/prh-remediation/boilerplate/apply
 *     Body: { approvedCodes: string[], overrides?: { [code]: html } }
 *     Injects the approved snippets into the copyright XHTML and
 *     returns the remediated filename. FE typically follows up with
 *     a re-audit to confirm the PRH-COPY-* issues cleared.
 *
 * Both endpoints require authentication. Tenant-scope check ensures
 * the requesting user owns the job's tenant — defence-in-depth on
 * top of `authenticate` middleware. The injector service throws
 * descriptive errors for non-PRH jobs / low-confidence detection /
 * missing copyright page; the controller translates these to 400s.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import {
  buildBoilerplateDraft,
  applyBoilerplate,
} from '../services/epub/profiles/prh-uk/remediators/boilerplate-injector.service';

const applyBoilerplateSchema = z.object({
  approvedCodes: z.array(z.string().min(1)).min(1, 'At least one code must be approved'),
  overrides: z.record(z.string(), z.string()).optional(),
}).strict();

class PrhRemediationController {
  /**
   * Verify the calling user has access to the job. Throws
   * AppError.notFound when the job doesn't exist OR belongs to a
   * different tenant (we don't leak the difference between "not
   * found" and "forbidden" to the client).
   */
  private async assertJobAccess(jobId: string, tenantId: string): Promise<void> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, tenantId: true },
    });
    if (!job || job.tenantId !== tenantId) {
      throw AppError.notFound(`Job ${jobId} not found`);
    }
  }

  /**
   * GET draft: returns the boilerplate snippets the operator can
   * choose to inject. Read-only — never mutates the EPUB.
   */
  async getBoilerplateDraft(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const { jobId } = req.params;
      await this.assertJobAccess(jobId, req.user.tenantId);

      const draft = await buildBoilerplateDraft(jobId);
      res.json({ success: true, data: draft });
    } catch (error) {
      // Service throws descriptive errors for non-PRH jobs and
      // low-confidence detection — surface them as 400s rather than
      // 500s so the FE can render a sensible "not applicable here"
      // message.
      if (error instanceof Error && /only runs on PRH-UK|medium-or-high|no audit output/i.test(error.message)) {
        return next(AppError.badRequest(error.message));
      }
      next(error);
    }
  }

  /**
   * POST apply: injects approved snippets into the copyright XHTML.
   * Returns the remediated filename + the list of codes actually
   * injected. FE typically follows up with a re-audit to confirm
   * the issues cleared.
   */
  async applyBoilerplate(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const { jobId } = req.params;
      await this.assertJobAccess(jobId, req.user.tenantId);

      const validation = applyBoilerplateSchema.safeParse(req.body);
      if (!validation.success) {
        throw AppError.badRequest('Invalid request body: ' + validation.error.message);
      }

      const result = await applyBoilerplate(jobId, validation.data);
      logger.info(`[PRH remediation] applied ${result.injectedCodes.length} boilerplate snippet(s) to job ${jobId}`);
      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof Error && /only runs on PRH-UK|medium-or-high|No snippets approved|Copyright page not found|EPUB buffer not found/i.test(error.message)) {
        return next(AppError.badRequest(error.message));
      }
      next(error);
    }
  }
}

export const prhRemediationController = new PrhRemediationController();
