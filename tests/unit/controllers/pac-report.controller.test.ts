/**
 * PacReportController.getLiveReport -- covers the file-fetch preference
 * order (remediated file first, falling back to the original upload) and
 * response shaping around axes4PacService.validate's ran/uaIndex/failures
 * result. GET /pac-report (Ninja's own free, simulated report) already has
 * its own coverage in pac-report.service.test.ts; this file is specifically
 * the new on-demand live-check endpoint.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: { job: { findFirst: vi.fn() } },
}));
vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    downloadFile: vi.fn(),
    getRemediatedFile: vi.fn(),
    getFile: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/axes4-pac.service', () => ({
  axes4PacService: { validate: vi.fn(), isAvailable: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { axes4PacService } from '../../../src/services/pdf/axes4-pac.service';
import { pacReportController } from '../../../src/controllers/pac-report.controller';
import type { AuthenticatedRequest } from '../../../src/types/authenticated-request';

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

const FAKE_BUFFER = Buffer.from('fake-pdf-bytes');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PacReportController.getLiveReport', () => {
  it('returns 401 when the request has no authenticated tenant', async () => {
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq({ user: undefined } as any), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the job does not exist or belongs to another tenant', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'JOB_NOT_FOUND' }) }));
  });

  it('prefers output.remediatedFileUrl via downloadFile when present', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: { remediatedFileUrl: 's3://bucket/remediated/doc.pdf' },
    } as any);
    vi.mocked(fileStorageService.downloadFile).mockResolvedValue(FAKE_BUFFER);
    vi.mocked(axes4PacService.validate).mockResolvedValue({ ran: false, failures: [] });
    vi.mocked(axes4PacService.isAvailable).mockReturnValue(false);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(fileStorageService.downloadFile).toHaveBeenCalledWith('s3://bucket/remediated/doc.pdf');
    expect(fileStorageService.getRemediatedFile).not.toHaveBeenCalled();
    expect(fileStorageService.getFile).not.toHaveBeenCalled();
    expect(axes4PacService.validate).toHaveBeenCalledWith(FAKE_BUFFER, 'doc.pdf');
  });

  it('falls back to getRemediatedFile when no remediatedFileUrl is recorded', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(FAKE_BUFFER);
    vi.mocked(axes4PacService.validate).mockResolvedValue({ ran: false, failures: [] });
    vi.mocked(axes4PacService.isAvailable).mockReturnValue(false);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(fileStorageService.getRemediatedFile).toHaveBeenCalledWith('job-1', 'doc.pdf');
    expect(fileStorageService.getFile).not.toHaveBeenCalled();
  });

  it('falls back further to the original uploaded file when no remediated file exists at all', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockRejectedValue(new Error('not found'));
    vi.mocked(fileStorageService.getFile).mockResolvedValue(FAKE_BUFFER);
    vi.mocked(axes4PacService.validate).mockResolvedValue({ ran: false, failures: [] });
    vi.mocked(axes4PacService.isAvailable).mockReturnValue(false);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(fileStorageService.getFile).toHaveBeenCalledWith('job-1', 'doc.pdf');
    expect(axes4PacService.validate).toHaveBeenCalledWith(FAKE_BUFFER, 'doc.pdf');
  });

  it('returns 404 FILE_NOT_FOUND when no file can be loaded from any source', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockRejectedValue(new Error('not found'));
    vi.mocked(fileStorageService.getFile).mockRejectedValue(new Error('not found'));
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'FILE_NOT_FOUND' }) }));
    expect(axes4PacService.validate).not.toHaveBeenCalled();
  });

  it('returns 200 with ran:false and configured:false when axes4 is not configured -- not treated as an error', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(FAKE_BUFFER);
    vi.mocked(axes4PacService.validate).mockResolvedValue({ ran: false, failures: [] });
    vi.mocked(axes4PacService.isAvailable).mockReturnValue(false);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { ran: false, uaIndex: undefined, failures: [], configured: false },
    });
  });

  it('returns 200 with the real result shape on a successful live check', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-1',
      input: { fileName: 'doc.pdf' },
      output: {},
    } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(FAKE_BUFFER);
    vi.mocked(axes4PacService.validate).mockResolvedValue({
      ran: true,
      uaIndex: 91.2,
      failures: [{ checkId: 'check-1', description: 'Missing alt text', pageNumber: 3, count: 1 }],
    });
    vi.mocked(axes4PacService.isAvailable).mockReturnValue(true);
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        ran: true,
        uaIndex: 91.2,
        failures: [{ checkId: 'check-1', description: 'Missing alt text', pageNumber: 3, count: 1 }],
        configured: true,
      },
    });
  });

  it('returns 500 INTERNAL_ERROR when something throws unexpectedly', async () => {
    vi.mocked(prisma.job.findFirst).mockRejectedValue(new Error('db down'));
    const res = makeRes();

    await pacReportController.getLiveReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) }));
  });
});
