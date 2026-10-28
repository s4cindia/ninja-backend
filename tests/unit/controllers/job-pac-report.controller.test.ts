/**
 * PacReportController's 4 new job-native external-PAC-report-upload
 * methods (getExternalUploadUrl/confirmExternalUpload/getExternalReport/
 * deleteExternalReport). authorizeJob/authorizeJobForReview + validate()
 * already ran by the time these handlers execute (covered by their own
 * middleware/schema tests) -- this file covers delegation to
 * job-pac-report.service.ts and response/error shaping only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: { job: { findFirst: vi.fn() } },
}));
vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { downloadFile: vi.fn(), getRemediatedFile: vi.fn(), getFile: vi.fn() },
}));
vi.mock('../../../src/services/pdf/axes4-pac.service', () => ({
  axes4PacService: { validate: vi.fn(), isAvailable: vi.fn() },
}));
vi.mock('../../../src/services/pdf/axes4-quota.service', () => ({
  axes4QuotaService: { getStatus: vi.fn() },
}));
vi.mock('../../../src/services/pdf/axes4-tenant-config.service', () => ({
  isAxes4EnabledForTenant: vi.fn(),
}));
vi.mock('../../../src/services/pdf/job-pac-report.service', () => ({
  getJobPacReportUploadUrl: vi.fn(),
  confirmJobPacReportUpload: vi.fn(),
  getJobPacReport: vi.fn(),
  deleteJobPacReport: vi.fn(),
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getJobPacReportUploadUrl,
  confirmJobPacReportUpload,
  getJobPacReport,
  deleteJobPacReport,
} from '../../../src/services/pdf/job-pac-report.service';
import { AppError } from '../../../src/utils/app-error';
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
    body: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PacReportController.getExternalUploadUrl', () => {
  it('delegates to getJobPacReportUploadUrl with the validated filename/contentType and returns 200', async () => {
    vi.mocked(getJobPacReportUploadUrl).mockResolvedValue({ uploadUrl: 'https://s3.example.com/signed', expiresIn: 1800 });
    const res = makeRes();

    await pacReportController.getExternalUploadUrl(
      makeReq({ body: { filename: 'report.pdf', contentType: 'application/pdf' } } as any),
      res,
    );

    expect(getJobPacReportUploadUrl).toHaveBeenCalledWith('job-1', 'report.pdf', 'application/pdf');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { uploadUrl: 'https://s3.example.com/signed', expiresIn: 1800 } });
  });

  it('maps an AppError from the service to its own statusCode/code instead of a generic 500', async () => {
    vi.mocked(getJobPacReportUploadUrl).mockRejectedValue(AppError.notFound('Job not found'));
    const res = makeRes();

    await pacReportController.getExternalUploadUrl(makeReq({ body: { filename: 'r.pdf', contentType: 'application/pdf' } } as any), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('PacReportController.confirmExternalUpload', () => {
  it('delegates with uploadedById from req.user, not the request body', async () => {
    vi.mocked(confirmJobPacReportUpload).mockResolvedValue({ id: 'report-1' } as any);
    const res = makeRes();

    await pacReportController.confirmExternalUpload(
      makeReq({
        body: { originalFileName: 'r.pdf', mimeType: 'application/pdf', summary: { pass: 1 } },
        user: { id: 'user-1', tenantId: 'tenant-1' },
      } as any),
      res,
    );

    expect(confirmJobPacReportUpload).toHaveBeenCalledWith('job-1', {
      originalFileName: 'r.pdf',
      mimeType: 'application/pdf',
      summary: { pass: 1 },
      uploadedById: 'user-1',
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 400 when the service reports the object never landed in S3', async () => {
    vi.mocked(confirmJobPacReportUpload).mockRejectedValue(AppError.badRequest('Uploaded file not found in S3'));
    const res = makeRes();

    await pacReportController.confirmExternalUpload(
      makeReq({ body: { originalFileName: 'r.pdf', mimeType: 'application/pdf', summary: {} } } as any),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('PacReportController.getExternalReport', () => {
  it('returns 200 with null data when nothing has been uploaded (not a 404)', async () => {
    vi.mocked(getJobPacReport).mockResolvedValue(null);
    const res = makeRes();

    await pacReportController.getExternalReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
  });

  it('returns the report when one exists', async () => {
    vi.mocked(getJobPacReport).mockResolvedValue({ id: 'report-1', downloadUrl: 'https://s3.example.com/dl' } as any);
    const res = makeRes();

    await pacReportController.getExternalReport(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'report-1', downloadUrl: 'https://s3.example.com/dl' } });
  });
});

describe('PacReportController.deleteExternalReport', () => {
  it('returns 200 on successful delete', async () => {
    vi.mocked(deleteJobPacReport).mockResolvedValue(true);
    const res = makeRes();

    await pacReportController.deleteExternalReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when no report exists for that job', async () => {
    vi.mocked(deleteJobPacReport).mockResolvedValue(false);
    const res = makeRes();

    await pacReportController.deleteExternalReport(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
