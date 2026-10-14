/**
 * Admin Team Management
 *
 * CRUD for Team/TeamMembership -- production-team oversight (Team Leader /
 * Executive / Viewer roles), layered on top of the existing single-owner
 * Job model. Orthogonal to UserRole (ADMIN/USER/VIEWER/OPERATOR), which
 * gates platform admin and research tooling -- a different axis. See the
 * RBAC design doc for the full rationale.
 *
 * ADMIN-only, tenant-scoped, mirroring admin/users.routes.ts's shape.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { TeamRole } from '@prisma/client';
import { authenticate } from '../../middleware/auth.middleware';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

const router = Router();

const TEAM_ROLE_VALUES = ['EXECUTIVE', 'TEAM_LEADER', 'VIEWER'] as const;

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

const teamMemberInclude = {
  members: {
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  },
} as const;

const createTeamBodySchema = z.object({
  name: z.string().min(1),
});

// POST /api/v1/admin/teams
router.post('/teams', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const parsed = createTeamBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const team = await prisma.team.create({ data: { name: parsed.data.name, tenantId } });

    return res.status(201).json({ success: true, data: team });
  } catch (err) {
    return internalError(res, 'POST /admin/teams', err);
  }
});

const listTeamsQuerySchema = z.object({
  limit: z.coerce.number().max(200).default(50),
});

// GET /api/v1/admin/teams
router.get('/teams', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const parsed = listTeamsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const teams = await prisma.team.findMany({
      where: { tenantId },
      take: parsed.data.limit,
      orderBy: { createdAt: 'desc' },
      include: teamMemberInclude,
    });

    return res.json({ success: true, data: { teams } });
  } catch (err) {
    return internalError(res, 'GET /admin/teams', err);
  }
});

// GET /api/v1/admin/teams/:id
router.get('/teams/:id', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const team = await prisma.team.findFirst({
      where: { id: req.params.id, tenantId },
      include: teamMemberInclude,
    });
    if (!team) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Team not found' } });
    }

    return res.json({ success: true, data: team });
  } catch (err) {
    return internalError(res, 'GET /admin/teams/:id', err);
  }
});

const addMemberBodySchema = z.object({
  userId: z.string().min(1),
  teamRole: z.enum(TEAM_ROLE_VALUES),
});

// POST /api/v1/admin/teams/:id/members
router.post('/teams/:id/members', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const parsed = addMemberBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: parsed.error.issues },
      });
    }

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const team = await prisma.team.findFirst({ where: { id: req.params.id, tenantId } });
    if (!team) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Team not found' } });
    }

    const { userId, teamRole } = parsed.data;

    // Target user must belong to the same tenant as the team -- otherwise an
    // admin could silently grant team-scoped job access across tenants.
    const targetUser = await prisma.user.findFirst({ where: { id: userId, tenantId, deletedAt: null } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found in this tenant' } });
    }

    // Upsert -- re-adding an existing member just changes their role, rather
    // than requiring a separate "update role" endpoint.
    const membership = await prisma.teamMembership.upsert({
      where: { teamId_userId: { teamId: team.id, userId } },
      create: { teamId: team.id, userId, teamRole: teamRole as TeamRole },
      update: { teamRole: teamRole as TeamRole },
    });

    return res.status(201).json({ success: true, data: membership });
  } catch (err) {
    return internalError(res, 'POST /admin/teams/:id/members', err);
  }
});

// DELETE /api/v1/admin/teams/:id/members/:userId
router.delete('/teams/:id/members/:userId', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);

    const tenantId = getUserFromReq(req)?.tenantId;
    if (!tenantId) return noTenant(res);

    const team = await prisma.team.findFirst({ where: { id: req.params.id, tenantId } });
    if (!team) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Team not found' } });
    }

    const deleted = await prisma.teamMembership.deleteMany({
      where: { teamId: team.id, userId: req.params.userId },
    });
    if (deleted.count === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Membership not found' } });
    }

    return res.json({ success: true, data: { teamId: team.id, userId: req.params.userId } });
  } catch (err) {
    return internalError(res, 'DELETE /admin/teams/:id/members/:userId', err);
  }
});

export default router;
