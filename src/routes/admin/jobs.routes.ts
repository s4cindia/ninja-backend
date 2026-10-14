/**
 * Admin Job Management
 *
 * ADMIN-only job reassignment -- lets an admin transfer ownership of a job
 * to a different user within the same tenant (e.g. an Executive leaves and
 * their in-progress titles need a new owner). See the RBAC design doc.
 *
 * ADMIN-only, tenant-scoped, mirroring admin/teams.routes.ts's shape.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

const router = Router();

const isAdmin = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return role === 'ADMIN';
};

const getUserFromReq = (req: Request) =>
  (req as Request & { user?: { userId?: string; id?: string; tenantId?: string } }).user;

const forbidden = (res: Response) =>
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } });

const noTenant = (res: Response) =>
  res.status(400).json({ success: false, error: { code: 'NO_TENANT', message: 'Admin must belong to a tenant' } });

const internalError = (res: Response, routeLabel: string, err: unknown) => {
  logger.error(`${routeLabel} error:`, err);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};

const reassignOwnerBodySchema = z.object({
  userId: z.string().min(1),
});

// PATCH /api/v1/admin/jobs/:jobId/owner
router.patch('/jobs/:jobId/owner', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const parsed = reassignOwnerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, tenantId } });
    if (!job) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }

    // Target user must belong to the same tenant -- otherwise an admin could
    // silently hand job ownership to an account outside this tenant.
    const targetUser = await prisma.user.findFirst({ where: { id: parsed.data.userId, tenantId, deletedAt: null } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found in this tenant' } });
    }

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { userId: targetUser.id },
    });

    return res.json({ success: true, data: { id: updated.id, userId: updated.userId } });
  } catch (err) {
    return internalError(res, 'PATCH /admin/jobs/:jobId/owner', err);
  }
});

export default router;
