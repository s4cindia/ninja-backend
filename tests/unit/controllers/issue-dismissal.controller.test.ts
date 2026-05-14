import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../src/services/issues/issue-dismissal.service', () => ({
  createDismissal: vi.fn(),
  deleteDismissal: vi.fn(),
  listDismissals: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../src/lib/prisma';
import {
  createDismissal,
  deleteDismissal,
  listDismissals,
} from '../../../src/services/issues/issue-dismissal.service';
import { issueDismissalController } from '../../../src/controllers/issue-dismissal.controller';

const mJobFindUnique = prisma.job.findUnique as ReturnType<typeof vi.fn>;
const mCreate = createDismissal as ReturnType<typeof vi.fn>;
const mDelete = deleteDismissal as ReturnType<typeof vi.fn>;
const mList = listDismissals as ReturnType<typeof vi.fn>;

let mockReq: Partial<Request>;
let mockRes: Partial<Response>;
let next: NextFunction & ReturnType<typeof vi.fn>;
let jsonMock: ReturnType<typeof vi.fn>;
let statusMock: ReturnType<typeof vi.fn>;
let sendMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  jsonMock = vi.fn();
  sendMock = vi.fn();
  statusMock = vi.fn().mockReturnValue({ send: sendMock, json: jsonMock });
  mockRes = { status: statusMock, json: jsonMock, send: sendMock };
  next = vi.fn() as NextFunction & ReturnType<typeof vi.fn>;
  mockReq = {
    params: { jobId: 'job-1' },
    body: {},
    query: {},
    user: { id: 'user-1', tenantId: 'tenant-1', email: 't@e.com', role: 'USER' },
  };
  // Default: the job exists and belongs to the caller's tenant.
  mJobFindUnique.mockResolvedValue({ id: 'job-1', tenantId: 'tenant-1' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IssueDismissalController.createDismissal', () => {
  it('creates a dismissal and returns { dismissal }', async () => {
    mockReq.body = { code: 'CODE', location: 'ch1.xhtml', message: 'msg', reason: 'FP' };
    const row = { id: 'd1', jobId: 'job-1' };
    mCreate.mockResolvedValue(row);

    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );

    expect(mCreate).toHaveBeenCalledWith({
      jobId: 'job-1',
      userId: 'user-1',
      code: 'CODE',
      location: 'ch1.xhtml',
      message: 'msg',
      reason: 'FP',
    });
    expect(jsonMock).toHaveBeenCalledWith({ success: true, data: { dismissal: row } });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults location to an empty string when omitted (location-less issues)', async () => {
    mockReq.body = { code: 'RSC-005', message: 'epubcheck fatal error' };
    mCreate.mockResolvedValue({ id: 'd1' });

    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );

    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RSC-005', location: '', message: 'epubcheck fatal error' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a missing code with a 400', async () => {
    mockReq.body = { location: 'ch1.xhtml', message: 'msg' };
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('rejects a reason longer than 280 characters with a 400', async () => {
    mockReq.body = {
      code: 'CODE',
      location: 'ch1.xhtml',
      message: 'msg',
      reason: 'x'.repeat(281),
    };
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly 280 characters', async () => {
    mockReq.body = {
      code: 'CODE',
      location: 'ch1.xhtml',
      message: 'msg',
      reason: 'x'.repeat(280),
    };
    mCreate.mockResolvedValue({ id: 'd1' });
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(mCreate).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unknown body fields (strict schema)', async () => {
    mockReq.body = { code: 'C', location: 'l', message: 'm', bogus: true };
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('returns 404 when the job belongs to a different tenant', async () => {
    mJobFindUnique.mockResolvedValue({ id: 'job-1', tenantId: 'OTHER-tenant' });
    mockReq.body = { code: 'C', location: 'l', message: 'm' };
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('returns 401 when the request is unauthenticated', async () => {
    mockReq.user = undefined;
    mockReq.body = { code: 'C', location: 'l', message: 'm' };
    await issueDismissalController.createDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
  });
});

describe('IssueDismissalController.deleteDismissal', () => {
  it('deletes a dismissal and returns 204', async () => {
    mockReq.params = { jobId: 'job-1', dismissalId: 'd1' };
    mDelete.mockResolvedValue(undefined);

    await issueDismissalController.deleteDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );

    expect(mDelete).toHaveBeenCalledWith('job-1', 'd1', 'user-1');
    expect(statusMock).toHaveBeenCalledWith(204);
    expect(sendMock).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a service 404 (cross-job IDOR) to next', async () => {
    mockReq.params = { jobId: 'job-1', dismissalId: 'd1' };
    const notFound = Object.assign(new Error('Dismissal d1 not found'), { statusCode: 404 });
    mDelete.mockRejectedValue(notFound);

    await issueDismissalController.deleteDismissal(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
  });
});

describe('IssueDismissalController.listDismissals', () => {
  it('returns { dismissals } for the job', async () => {
    const rows = [{ id: 'd1' }, { id: 'd2' }];
    mList.mockResolvedValue(rows);

    await issueDismissalController.listDismissals(
      mockReq as Request,
      mockRes as Response,
      next,
    );

    expect(mList).toHaveBeenCalledWith('job-1', { code: undefined });
    expect(jsonMock).toHaveBeenCalledWith({ success: true, data: { dismissals: rows } });
  });

  it('passes the code query filter through to the service', async () => {
    mockReq.query = { code: 'PRH-HASHTAG-NOT-CAMEL-CASE' };
    mList.mockResolvedValue([]);

    await issueDismissalController.listDismissals(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(mList).toHaveBeenCalledWith('job-1', { code: 'PRH-HASHTAG-NOT-CAMEL-CASE' });
  });

  it('returns 404 when the job is not owned by the caller', async () => {
    mJobFindUnique.mockResolvedValue(null);
    await issueDismissalController.listDismissals(
      mockReq as Request,
      mockRes as Response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    expect(mList).not.toHaveBeenCalled();
  });
});
