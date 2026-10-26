/**
 * Operational Reports
 *
 * Internal/operational reporting -- distinct from PAC/ACR/VPAT compliance
 * reports. See OPERATIONAL_REPORTS_DESIGN.md for the full 5-group design;
 * this file ships Group 1 (Time/throughput) first since it needs zero new
 * schema.
 *
 * ADMIN-only, tenant-scoped, mirroring admin/teams.routes.ts's shape.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { logger } from '../../lib/logger';
import { throughputReportService } from '../../services/reports/throughput-report.service';
import { teamActivityReportService } from '../../services/reports/team-activity-report.service';

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
  return res
    .status(500)
    .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

interface ParsedDateRange {
  from: Date;
  to: Date;
}

/** Returns null on anything invalid -- caller responds 422, doesn't guess. */
function parseDateRange(req: Request): ParsedDateRange | null {
  const now = new Date();
  const to = req.query.to ? new Date(String(req.query.to)) : now;
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - DEFAULT_RANGE_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (from.getTime() > to.getTime()) return null;
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) return null;

  return { from, to };
}

function parseRange(req: Request): (ParsedDateRange & { groupBy: 'day' | 'week' }) | null {
  const range = parseDateRange(req);
  if (!range) return null;
  const groupBy = req.query.groupBy === 'week' ? 'week' : 'day';
  return { ...range, groupBy };
}

// GET /api/v1/admin/reports/throughput
router.get('/reports/throughput', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);
    const user = getUserFromReq(req);
    if (!user?.tenantId) return noTenant(res);

    const range = parseRange(req);
    if (!range) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid from/to/groupBy, or range exceeds 90 days' },
      });
    }

    const report = await throughputReportService.getReport({ tenantId: user.tenantId, ...range });
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/throughput', err);
  }
});

// GET /api/v1/admin/reports/team-activity
router.get('/reports/team-activity', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);
    const user = getUserFromReq(req);
    if (!user?.tenantId) return noTenant(res);

    const range = parseDateRange(req);
    if (!range) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid from/to, or range exceeds 90 days' },
      });
    }

    const report = await teamActivityReportService.getReport({ tenantId: user.tenantId, ...range });
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/team-activity', err);
  }
});

export default router;
