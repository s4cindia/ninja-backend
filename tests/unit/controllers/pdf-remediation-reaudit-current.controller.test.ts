/**
 * PdfRemediationController.reauditCurrentFile
 *
 * New endpoint (no file upload) that re-runs the audit against a job's
 * current server-side file — the remediated version if one exists,
 * otherwise the original — and persists the fresh AuditReport into
 * job.output.auditReport. This is what makes "re-run audit" actually
 * show updated score/Matterhorn/issues instead of the stale pre-fix
 * numbers (see pdf-reaudit.service.test.ts for the underlying fix).
 *
 * Also covers the remediation-cycle lock: this endpoint must reject with
 * 409 while another apply-fixes/re-audit/AI-analysis cycle is in flight on
 * the same job, and must re-fetch job.output immediately before its final
 * write (not reuse the pre-audit findFirst snapshot) so it doesn't clobber
 * pdf-reaudit.service's own mid-flight progress writes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import { pdfRemediationController } from '../../../src/controllers/pdf-remediation.controller';
import { AuthenticatedRequest } from '../../../src/types/authenticated-request';
import prisma from '../../../src/lib/prisma';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { pdfReauditService } from '../../../src/services/pdf/pdf-reaudit.service';
import { AuditReport } from '../../../src/services/audit/base-audit.service';
import { ReauditComparisonResult } from '../../../src/types/pdf-reaudit.types';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    remediationCycleEvent: { create: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('../../../src/services/storage/file-storage.service');
vi.mock('../../../src/services/pdf/pdf-reaudit.service');
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: { jobId: 'job-1' },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function emptyMetrics(): ReauditComparisonResult['metrics'] {
  return {
    totalOriginal: 0, totalNew: 0, resolvedCount: 0, remainingCount: 0, regressionCount: 0, resolutionRate: 0,
    criticalResolved: 0, criticalRemaining: 0,
    severityBreakdown: {
      critical: { resolved: 0, remaining: 0 }, serious: { resolved: 0, remaining: 0 },
      moderate: { resolved: 0, remaining: 0 }, minor: { resolved: 0, remaining: 0 },
    },
  };
}

/** Mocks a successful lock acquisition (updateMany affects 1 row) and makes
 * job.findUnique — used both by the lock's cycleNumber readback and by the
 * controller's re-fetch-before-write — return the given output. */
function mockLockAcquired(output: Record<string, unknown> = {}) {
  vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.job.findUnique).mockResolvedValue({
    id: 'job-1',
    output,
    remediationCycleCounter: 1,
    remediationCycleLockedAt: new Date(),
    remediationCycleLockedBy: 'user-1',
    remediationCycleSource: 'reaudit_current_file',
  } as any);
  vi.mocked(prisma.remediationCycleEvent.create).mockResolvedValue({} as any);
}

describe('PdfRemediationController.reauditCurrentFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq({ user: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when the job does not exist (or belongs to another tenant)', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 for a non-PDF job', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'EPUB_ACCESSIBILITY', input: {}, output: {} } as any);
    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when no stored file exists at all', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {} } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(null);
    vi.mocked(fileStorageService.getFile).mockResolvedValue(null);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'FILE_NOT_FOUND' }),
    }));
  });

  it('returns 409 when a remediation cycle is already in progress for this job', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {} } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('remediated'));
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 0 } as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      remediationCycleLockedAt: new Date(),
      remediationCycleLockedBy: 'other-user',
      remediationCycleSource: 'apply_all',
    } as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'REMEDIATION_CYCLE_IN_PROGRESS' }),
    }));
    expect(pdfReauditService.reauditAndCompare).not.toHaveBeenCalled();
  });

  it('prefers the remediated file over the original when both exist', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {} } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('remediated'));
    vi.mocked(fileStorageService.getFile).mockResolvedValue(Buffer.from('original'));
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true, jobId: 'job-1', originalAuditId: 'job-1', reauditId: 'job-1-reaudit', fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
    });
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledWith('job-1', Buffer.from('remediated'), 'doc.pdf');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('falls back to the original file when no remediated version exists', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {} } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(null);
    vi.mocked(fileStorageService.getFile).mockResolvedValue(Buffer.from('original'));
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true, jobId: 'job-1', originalAuditId: 'job-1', reauditId: 'job-1-reaudit', fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
    });
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    expect(pdfReauditService.reauditAndCompare).toHaveBeenCalledWith('job-1', Buffer.from('original'), 'doc.pdf');
  });

  it('persists the fresh auditReport into job.output on a successful re-audit', async () => {
    const freshReport = { score: 42, issues: [{ id: 'x' }] } as unknown as AuditReport;
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' },
      output: { auditReport: { score: 0 } },
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('remediated'));
    mockLockAcquired({ auditReport: { score: 0 } });
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: true, jobId: 'job-1', originalAuditId: 'job-1', reauditId: 'job-1-reaudit', fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
      reauditReport: freshReport,
    });
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    const updateCall = vi.mocked(prisma.job.update).mock.calls[0][0];
    expect((updateCall.data.output as any).auditReport).toBe(freshReport);
    // Success path also sets postRemediationStatus/postRemediationAudit,
    // matching applyAll/reauditPdf's shape.
    expect((updateCall.data.output as any).postRemediationStatus).toBe('complete');
  });

  it('does not overwrite auditReport when the re-audit itself fails', async () => {
    const staleReport = { score: 50 };
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' },
      output: { auditReport: staleReport },
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('remediated'));
    // The controller re-fetches via findUnique immediately before its final
    // write -- it must see the same stale output the pre-audit findFirst saw.
    mockLockAcquired({ auditReport: staleReport });
    vi.mocked(pdfReauditService.reauditAndCompare).mockResolvedValue({
      success: false, jobId: 'job-1', originalAuditId: 'job-1', reauditId: '', fileName: 'doc.pdf',
      comparison: { resolved: [], remaining: [], regressions: [] }, metrics: emptyMetrics(),
      error: 'Re-audit failed: boom',
    });
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    const updateCall = vi.mocked(prisma.job.update).mock.calls[0][0];
    expect((updateCall.data.output as any).auditReport).toBe(staleReport);
    expect((updateCall.data.output as any).postRemediationStatus).toBeUndefined();
  });

  it('releases the lock even when the re-audit throws', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({ id: 'job-1', type: 'PDF_ACCESSIBILITY', input: { fileName: 'doc.pdf' }, output: {} } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('remediated'));
    mockLockAcquired({});
    vi.mocked(pdfReauditService.reauditAndCompare).mockRejectedValue(new Error('boom'));
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);

    const res = makeRes();
    await pdfRemediationController.reauditCurrentFile(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    // releaseLock -> prisma.job.update clearing the lock columns
    expect(prisma.job.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1' },
      data: expect.objectContaining({ remediationCycleLockedAt: null }),
    }));
  });
});
