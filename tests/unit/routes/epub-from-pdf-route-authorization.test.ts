/**
 * Which authorization middleware each EPUB-from-certified-PDF-related route
 * actually runs. The Team-Leader-action tier is deliberately narrow, so
 * this pins both directions: the evidence/EPUB-settings routes accept the
 * owner's Team Leader, and the paid axes4 live check / general settings do not.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Router } from 'express';

vi.mock('../../../src/controllers/pac-report.controller', () => ({ pacReportController: {} }));
vi.mock('../../../src/controllers/acrobat-report.controller', () => ({ acrobatReportController: {} }));
vi.mock('../../../src/controllers/pdf-auto-mode.controller', () => ({
  pdfAutoModeController: new Proxy({}, { get: () => () => undefined }),
}));

import {
  authorizeJob,
  authorizeJobForReview,
  authorizeJobForTeamLeaderAction,
} from '../../../src/middleware/authorize-job.middleware';
import pacReportRoutes from '../../../src/routes/pac-report.routes';
import acrobatReportRoutes from '../../../src/routes/acrobat-report.routes';
import pdfAutoModeRoutes from '../../../src/routes/pdf-auto-mode.routes';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }

function authFor(router: Router, method: string, path: string): unknown {
  const layer = (router.stack as unknown as Layer[]).find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const handles = layer.route.stack.map((s) => s.handle);
  const found = [authorizeJob, authorizeJobForReview, authorizeJobForTeamLeaderAction].filter((m) => handles.includes(m));
  expect(found).toHaveLength(1);
  return found[0];
}

describe('EPUB-from-PDF route authorization', () => {
  it.each([
    [pacReportRoutes, 'post', '/:jobId/pac-report/external/upload-url'],
    [pacReportRoutes, 'post', '/:jobId/pac-report/external/confirm'],
    [pacReportRoutes, 'delete', '/:jobId/pac-report/external'],
    [acrobatReportRoutes, 'post', '/:jobId/acrobat-report/upload-url'],
    [acrobatReportRoutes, 'post', '/:jobId/acrobat-report/confirm'],
    [acrobatReportRoutes, 'delete', '/:jobId/acrobat-report'],
    [pdfAutoModeRoutes, 'patch', '/:jobId/settings/epub'],
  ] as const)('%#: %s %s accepts the owner\'s Team Leader', (router, method, path) => {
    expect(authFor(router as unknown as Router, method, path)).toBe(authorizeJobForTeamLeaderAction);
  });

  it.each([
    [pacReportRoutes, 'post', '/:jobId/pac-report/live'],
    [pdfAutoModeRoutes, 'patch', '/:jobId/settings'],
  ] as const)('%#: %s %s stays owner/ADMIN only', (router, method, path) => {
    expect(authFor(router as unknown as Router, method, path)).toBe(authorizeJob);
  });

  it.each([
    [pacReportRoutes, 'get', '/:jobId/pac-report/external'],
    [acrobatReportRoutes, 'get', '/:jobId/acrobat-report'],
    [pdfAutoModeRoutes, 'get', '/:jobId/settings'],
  ] as const)('%#: %s %s is a team-review read', (router, method, path) => {
    expect(authFor(router as unknown as Router, method, path)).toBe(authorizeJobForReview);
  });
});
