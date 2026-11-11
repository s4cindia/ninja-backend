/**
 * feedbackController -- severity validation/pass-through added for the UAT
 * defect-logging extension. Existing type/status/rating validation is
 * pre-existing behavior, exercised here only incidentally.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'express';

vi.mock('../../../src/services/feedback/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/feedback/feedback.service')>(
    '../../../src/services/feedback/feedback.service'
  );
  return {
    ...actual,
    feedbackService: {
      createFeedback: vi.fn(),
      listFeedback: vi.fn(),
      updateFeedbackStatus: vi.fn(),
    },
  };
});

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { feedbackService } from '../../../src/services/feedback/feedback.service';
import { feedbackController } from '../../../src/controllers/feedback.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}): any {
  return {
    body,
    query,
    params: { id: 'f-1' },
    user: { id: 'user-1', email: 'user@x.com', tenantId: 't-1' },
  };
}

describe('feedbackController.create -- severity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (feedbackService.createFeedback as any).mockResolvedValue({ id: 'f-1' });
  });

  it('accepts a valid severity and passes it through', async () => {
    const req = makeReq({ type: 'bug_report', severity: 'critical', comment: 'it is broken' });
    const res = makeRes();

    await feedbackController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(feedbackService.createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'CRITICAL' })
    );
  });

  it('works with no severity at all (optional field)', async () => {
    const req = makeReq({ type: 'general', comment: 'just a thought' });
    const res = makeRes();

    await feedbackController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(feedbackService.createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ severity: undefined })
    );
  });

  it('rejects an invalid severity with 400, never reaching the service', async () => {
    const req = makeReq({ type: 'bug_report', severity: 'catastrophic', comment: 'it is broken' });
    const res = makeRes();

    await feedbackController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(feedbackService.createFeedback).not.toHaveBeenCalled();
  });
});

describe('feedbackController.list -- severity filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (feedbackService.listFeedback as any).mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 });
  });

  it('passes a severity query param through as a filter', async () => {
    const req = makeReq({}, { severity: 'high' });
    const res = makeRes();

    await feedbackController.list(req, res);

    expect(feedbackService.listFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'HIGH' }),
      1,
      20
    );
  });

  it('omits the severity filter when absent from the query', async () => {
    const req = makeReq({}, {});
    const res = makeRes();

    await feedbackController.list(req, res);

    expect(feedbackService.listFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ severity: undefined }),
      1,
      20
    );
  });
});

describe('feedbackController.updateStatus -- severity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (feedbackService.updateFeedbackStatus as any).mockResolvedValue({ id: 'f-1', status: 'RESOLVED' });
  });

  it('passes a valid severity through alongside status', async () => {
    const req = makeReq({ status: 'resolved', severity: 'low' });
    const res = makeRes();

    await feedbackController.updateStatus(req, res);

    expect(feedbackService.updateFeedbackStatus).toHaveBeenCalledWith(
      'f-1', 't-1', 'RESOLVED', undefined, 'user-1', 'LOW'
    );
  });

  it('rejects an invalid severity with 400, never reaching the service', async () => {
    const req = makeReq({ status: 'resolved', severity: 'urgent' });
    const res = makeRes();

    await feedbackController.updateStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(feedbackService.updateFeedbackStatus).not.toHaveBeenCalled();
  });

  it('still works with no severity given at all (unchanged existing behavior)', async () => {
    const req = makeReq({ status: 'resolved' });
    const res = makeRes();

    await feedbackController.updateStatus(req, res);

    expect(feedbackService.updateFeedbackStatus).toHaveBeenCalledWith(
      'f-1', 't-1', 'RESOLVED', undefined, 'user-1', undefined
    );
  });
});
