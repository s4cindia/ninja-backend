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
import prisma from '../../lib/prisma';
import { throughputReportService } from '../../services/reports/throughput-report.service';
import { teamActivityReportService } from '../../services/reports/team-activity-report.service';
import { costReportService } from '../../services/reports/cost-report.service';
import { reliabilityReportService } from '../../services/reports/reliability-report.service';
import { qualityReportService } from '../../services/reports/quality-report.service';

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

// GET /api/v1/admin/reports/cost
router.get('/reports/cost', authenticate, async (req: Request, res: Response) => {
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

    const report = await costReportService.getReport({ tenantId: user.tenantId, ...range });
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/cost', err);
  }
});

// GET /api/v1/admin/reports/cost/:jobId/rounds
router.get('/reports/cost/:jobId/rounds', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);
    const user = getUserFromReq(req);
    if (!user?.tenantId) return noTenant(res);

    // Not tenant-filterable at the RemediationCycleEvent query level (it
    // only carries jobId), so check ownership explicitly first -- an ADMIN
    // is tenant-scoped everywhere else in this file, and a bare jobId query
    // param would otherwise let one tenant's ADMIN pull another tenant's
    // cost trend just by guessing/trying a jobId.
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId }, select: { tenantId: true } });
    if (!job || job.tenantId !== user.tenantId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }

    const trend = await costReportService.getRoundCostTrend(req.params.jobId);
    return res.json({ success: true, data: { jobId: req.params.jobId, rounds: trend } });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/cost/:jobId/rounds', err);
  }
});

// GET /api/v1/admin/reports/reliability
router.get('/reports/reliability', authenticate, async (req: Request, res: Response) => {
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

    const report = await reliabilityReportService.getReport({ tenantId: user.tenantId, ...range });
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/reliability', err);
  }
});

// GET /api/v1/admin/reports/quality
router.get('/reports/quality', authenticate, async (req: Request, res: Response) => {
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

    const report = await qualityReportService.getReport({ tenantId: user.tenantId, ...range });
    return res.json({ success: true, data: report });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/quality', err);
  }
});

// GET /api/v1/admin/reports/quality/stuck-issues
router.get('/reports/quality/stuck-issues', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);
    const user = getUserFromReq(req);
    if (!user?.tenantId) return noTenant(res);

    const stuckIssues = await qualityReportService.getStuckIssues(user.tenantId);
    return res.json({ success: true, data: { stuckIssues } });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/quality/stuck-issues', err);
  }
});

// GET /api/v1/admin/reports/quality/:jobId/score-trend
router.get('/reports/quality/:jobId/score-trend', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) return forbidden(res);
    const user = getUserFromReq(req);
    if (!user?.tenantId) return noTenant(res);

    // Same ownership check as GET /admin/reports/cost/:jobId/rounds --
    // RemediationCycleEvent carries no tenantId itself.
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId }, select: { tenantId: true } });
    if (!job || job.tenantId !== user.tenantId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }

    const trend = await qualityReportService.getScoreTrend(req.params.jobId);
    return res.json({ success: true, data: { jobId: req.params.jobId, rounds: trend } });
  } catch (err) {
    return internalError(res, 'GET /admin/reports/quality/:jobId/score-trend', err);
  }
});

export default router;
