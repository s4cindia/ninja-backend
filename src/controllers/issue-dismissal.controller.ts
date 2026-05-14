/**
 * Audit-issue dismissal controller.
 *
 *   POST   /api/v1/jobs/:jobId/issues/dismissals
 *     Body: { code, location, message, reason? }
 *     Dismisses one issue instance. Idempotent — re-POSTing the same
 *     { code, location, message } returns the existing row.
 *
 *   DELETE /api/v1/jobs/:jobId/issues/dismissals/:dismissalId
 *     Removes a dismissal. 404 (not 403) when the dismissal belongs
 *     to a different job — leaks less than confirming the id exists.
 *
 *   GET    /api/v1/jobs/:jobId/issues/dismissals?code=:code
 *     Lists dismissals for the job; `code` filter is optional.
 *
 * All endpoints require `authenticate`; each then verifies the user's
 * tenant owns the job (defence-in-depth on top of the middleware).
 *
 * Response contract is the one the FE (P2-P3 Prompt 9) was built
 * against: POST -> { dismissal }, GET -> { dismissals }, DELETE -> 204.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import {
  createDismissal,
  deleteDismissal,
  listDismissals,
} from '../services/issues/issue-dismissal.service';

const createDismissalSchema = z
  .object({
    code: z.string().min(1, 'code is required'),
    location: z.string().min(1, 'location is required'),
    message: z.string().min(1, 'message is required'),
    reason: z.string().max(280, 'reason must be 280 characters or fewer').optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
  })
  .strict();

class IssueDismissalController {
  /**
   * Verify the calling user's tenant owns the job. Throws
   * AppError.notFound when the job doesn't exist OR belongs to a
   * different tenant — we don't leak the difference to the client.
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
   * POST — dismiss one issue instance. Idempotent: the service
   * resolves a unique-constraint collision to the existing row, so
   * a double-POST returns 200 with the same row rather than 500.
   */
  async createDismissal(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const { jobId } = req.params;
      await this.assertJobAccess(jobId, req.user.tenantId);

      const validation = createDismissalSchema.safeParse(req.body);
      if (!validation.success) {
        throw AppError.badRequest('Invalid request body: ' + validation.error.message);
      }

      const dismissal = await createDismissal({
        jobId,
        userId: req.user.id,
        code: validation.data.code,
        location: validation.data.location,
        message: validation.data.message,
        reason: validation.data.reason,
      });
      res.json({ dismissal });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE — remove a dismissal. The service verifies the dismissal
   * belongs to `jobId` and throws AppError.notFound otherwise.
   */
  async deleteDismissal(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const { jobId, dismissalId } = req.params;
      await this.assertJobAccess(jobId, req.user.tenantId);

      await deleteDismissal(jobId, dismissalId, req.user.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET — list dismissals for the job, optionally filtered by code.
   */
  async listDismissals(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const { jobId } = req.params;
      await this.assertJobAccess(jobId, req.user.tenantId);

      const validation = listQuerySchema.safeParse(req.query);
      if (!validation.success) {
        throw AppError.badRequest('Invalid query parameters: ' + validation.error.message);
      }

      const dismissals = await listDismissals(jobId, { code: validation.data.code });
      logger.debug(
        `[issue-dismissal] listed ${dismissals.length} dismissal(s) for job ${jobId}`,
      );
      res.json({ dismissals });
    } catch (error) {
      next(error);
    }
  }
}

export const issueDismissalController = new IssueDismissalController();
