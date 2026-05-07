import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/calibration/corpus-status.service', () => ({
  listCorpusStatus: vi.fn(),
  updateDocumentStatus: vi.fn(),
}));

import {
  listCorpusStatus,
  updateDocumentStatus,
} from '../../../src/services/calibration/corpus-status.service';
import {
  getCorpusStatus,
  putCorpusDocumentStatus,
} from '../../../src/controllers/corpus-status.controller';

const mList = listCorpusStatus as ReturnType<typeof vi.fn>;
const mUpdate = updateDocumentStatus as ReturnType<typeof vi.fn>;

function makeRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res._status = code;
    return res as Response;
  });
  res.json = vi.fn().mockImplementation((body: unknown) => {
    res._body = body;
    return res as Response;
  });
  return res as Response & { _status?: number; _body?: unknown };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

describe('getCorpusStatus', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns 401 when unauthenticated', async () => {
    const req = makeReq();
    const res = makeRes();
    await getCorpusStatus(req, res);
    expect(res._status).toBe(401);
    expect(mList).not.toHaveBeenCalled();
  });

  it('returns 403 for a USER role', async () => {
    const req = makeReq({
      user: { id: 'u1', email: 'x@x.com', tenantId: 't1', role: 'USER' },
    } as Partial<Request>);
    const res = makeRes();
    await getCorpusStatus(req, res);
    expect(res._status).toBe(403);
    expect(mList).not.toHaveBeenCalled();
  });

  it('returns 200 with rows for OPERATOR', async () => {
    const data = { rows: [], generatedAt: '2026-05-07T00:00:00Z' };
    mList.mockResolvedValue(data);
    const req = makeReq({
      user: { id: 'u1', email: 'x@x.com', tenantId: 't1', role: 'OPERATOR' },
    } as Partial<Request>);
    const res = makeRes();
    await getCorpusStatus(req, res);
    expect(res._body).toEqual({ success: true, data });
  });

  it('returns 200 for ADMIN', async () => {
    mList.mockResolvedValue({ rows: [], generatedAt: 'x' });
    const req = makeReq({
      user: { id: 'u1', email: 'x@x.com', tenantId: 't1', role: 'ADMIN' },
    } as Partial<Request>);
    const res = makeRes();
    await getCorpusStatus(req, res);
    expect(mList).toHaveBeenCalledOnce();
  });
});

describe('putCorpusDocumentStatus', () => {
  beforeEach(() => vi.resetAllMocks());

  const adminUser = {
    id: 'admin-1',
    email: 'a@x.com',
    tenantId: 't1',
    role: 'ADMIN',
  };

  it('returns 401 when unauthenticated', async () => {
    const req = makeReq({
      params: { documentId: 'd1' },
      body: { statusOverride: 'BLOCKED' },
    });
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 403 when role is USER', async () => {
    const req = makeReq({
      user: { ...adminUser, role: 'USER' },
      params: { documentId: 'd1' },
      body: { statusOverride: 'BLOCKED' },
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(403);
  });

  it('returns 400 for invalid statusOverride enum value', async () => {
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'd1' },
      body: { statusOverride: 'GARBAGE' },
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(400);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 for statusNote longer than 500 chars', async () => {
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'd1' },
      body: { statusNote: 'x'.repeat(501) },
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(400);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when neither field is supplied', async () => {
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'd1' },
      body: {},
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 404 when document does not exist', async () => {
    mUpdate.mockResolvedValue(null);
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'missing' },
      body: { statusOverride: 'BLOCKED' },
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    expect(res._status).toBe(404);
  });

  it('returns 200 with updated row on success', async () => {
    const updatedRow = {
      serialNumber: 1,
      documentId: 'd1',
      filename: 'a.pdf',
      pageCount: 100,
      pagesAnnotated: 50,
      status: 'BLOCKED',
      statusOverride: 'BLOCKED',
      primaryAnnotator: null,
      otherAnnotatorCount: 0,
      hoursSpent: 0,
      lastUpdatedAt: '2026-05-07T00:00:00Z',
      statusNote: 'engineering issue',
    };
    mUpdate.mockResolvedValue(updatedRow);
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'd1' },
      body: { statusOverride: 'BLOCKED', statusNote: 'engineering issue' },
    } as Partial<Request>);
    const res = makeRes();

    await putCorpusDocumentStatus(req, res);

    expect(mUpdate).toHaveBeenCalledWith(
      'd1',
      { statusOverride: 'BLOCKED', statusNote: 'engineering issue' },
      'admin-1',
    );
    expect(res._body).toEqual({ success: true, data: updatedRow });
  });

  it('accepts statusOverride: null to clear', async () => {
    mUpdate.mockResolvedValue({ documentId: 'd1', status: 'NOT_STARTED' });
    const req = makeReq({
      user: adminUser,
      params: { documentId: 'd1' },
      body: { statusOverride: null },
    } as Partial<Request>);
    const res = makeRes();
    await putCorpusDocumentStatus(req, res);
    const args = mUpdate.mock.calls[0];
    expect(args[1]).toEqual({ statusOverride: null });
  });
});
