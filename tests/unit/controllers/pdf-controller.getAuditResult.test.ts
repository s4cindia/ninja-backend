/**
 * PdfController.getAuditResult -- non-COMPLETED branch
 *
 * Regression for a real production bug: for a FAILED job, this endpoint
 * used to return only { status, message: 'Audit not started' } -- job.error
 * (the actual failure reason, e.g. "PDF file exceeds maximum size of
 * 500MB") was silently dropped, so the frontend could only ever show a
 * generic "Audit failed. Please try again." with nothing to act on
 * (real incident, 2026-09-25).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { pdfController } from '../../../src/controllers/pdf.controller';

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(job: Record<string, unknown>): Request {
  return { job } as unknown as Request;
}

describe('PdfController.getAuditResult', () => {
  it('surfaces job.error and uses it as the message for a FAILED job', async () => {
    const req = makeReq({ id: 'job-1', status: 'FAILED', error: 'PDF file exceeds maximum size of 500MB' });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'FAILED',
        message: 'PDF file exceeds maximum size of 500MB',
        error: 'PDF file exceeds maximum size of 500MB',
      },
    });
  });

  it('falls back to a generic message when a FAILED job has no error recorded', async () => {
    const req = makeReq({ id: 'job-1', status: 'FAILED', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'FAILED',
        message: 'Audit failed',
        error: null,
      },
    });
  });

  it('still reports "Audit in progress" for a PROCESSING job, with error: null', async () => {
    const req = makeReq({ id: 'job-1', status: 'PROCESSING', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'PROCESSING',
        message: 'Audit in progress',
        error: null,
      },
    });
  });

  it('still reports "Audit not started" for a QUEUED job', async () => {
    const req = makeReq({ id: 'job-1', status: 'QUEUED', error: null });
    const res = makeRes();

    await pdfController.getAuditResult(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        status: 'QUEUED',
        message: 'Audit not started',
        error: null,
      },
    });
  });
});
