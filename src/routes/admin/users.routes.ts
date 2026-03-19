import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { authenticate } from '../../middleware/auth.middleware';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

const router = Router();

const ROLE_VALUES = ['USER', 'OPERATOR', 'ADMIN', 'VIEWER'] as const;

const isAdmin = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return role === 'ADMIN';
};

const getUserFromReq = (req: Request) =>
  (req as Request & { user?: { userId?: string; id?: string; tenantId?: string } }).user;

const createUserBodySchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(ROLE_VALUES).default('OPERATOR'),
  password: z.string().min(8).max(72),
});

// POST /api/v1/admin/users
router.post('/users', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = createUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { email, firstName, lastName, role, password } = parsed.data;

    const existing = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_IN_USE', message: 'Email address already registered' },
      });
    }

    const reqUser = getUserFromReq(req);
    const tenantId = reqUser?.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_TENANT', message: 'Admin must belong to a tenant' },
      });
    }

    const hashed = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        role: role as UserRole,
        password: hashed,
        tenantId,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    logger.error('POST /admin/users error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

const listUsersQuerySchema = z.object({
  role: z.enum(ROLE_VALUES).optional(),
  limit: z.coerce.number().max(200).default(50),
});

// GET /api/v1/admin/users
router.get('/users', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = listUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { role, limit } = parsed.data;

    const reqUser = getUserFromReq(req);
    const tenantId = reqUser?.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_TENANT', message: 'Admin must belong to a tenant' },
      });
    }

    const users = await prisma.user.findMany({
      where: {
        tenantId,
        ...(role ? { role: role as UserRole } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        tenantId: true,
      },
    });

    return res.json({ success: true, data: { users } });
  } catch (err) {
    logger.error('GET /admin/users error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

const updateRoleBodySchema = z.object({
  role: z.enum(ROLE_VALUES),
});

// PATCH /api/v1/admin/users/:id/role
router.patch('/users/:id/role', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = updateRoleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const reqUser = getUserFromReq(req);
    const requesterId = reqUser?.userId ?? reqUser?.id;
    if (requesterId === req.params.id) {
      return res.status(400).json({
        success: false,
        error: { code: 'SELF_ROLE_CHANGE', message: 'Cannot change your own role' },
      });
    }

    const tenantId = reqUser?.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_TENANT', message: 'Admin must belong to a tenant' },
      });
    }

    // Verify target user exists and belongs to the same tenant
    const targetUser = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { role: parsed.data.role as UserRole },
    });
    return res.json({
      success: true,
      data: { id: updated.id, role: updated.role },
    });
  } catch (err) {
    logger.error('PATCH /admin/users/:id/role error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

export default router;
