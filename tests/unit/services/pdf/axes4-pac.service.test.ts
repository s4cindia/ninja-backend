/**
 * axes4 PAC Cloud API client -- covers isAvailable() gating, the
 * submit-then-fetch-details HTTP flow, the local quota pre-check, and each
 * documented error code (401/403/413/422/timeout/5xx-retry) degrading to a
 * clean `ran:false` rather than throwing past the caller. Real PDF bytes
 * (via pdf-lib) for the local page-count read; `global.fetch` and
 * axes4QuotaService are mocked to control the HTTP/quota layers precisely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mockConfig = {
  apiKey: 'test-key',
  subscriptionId: 'test-subscription',
  apiUrl: 'https://api.axes4.com/pac',
  timeoutMs: 5000,
  checksets: ['pdfua'],
  quota: { defaultPagesPerPeriod: 500, periodDays: 30 },
};

vi.mock('../../../../src/config/axes4.config', () => ({
  get axes4Config() {
    return mockConfig;
  },
}));

vi.mock('../../../../src/services/pdf/axes4-quota.service', () => ({
  axes4QuotaService: { tryReservePages: vi.fn() },
}));

import { axes4PacService } from '../../../../src/services/pdf/axes4-pac.service';
import { axes4QuotaService } from '../../../../src/services/pdf/axes4-quota.service';

async function makePdfBuffer(pageCount = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.apiKey = 'test-key';
  mockConfig.subscriptionId = 'test-subscription';
  vi.mocked(axes4QuotaService.tryReservePages).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isAvailable', () => {
  it('true when both credentials are set', () => {
    expect(axes4PacService.isAvailable()).toBe(true);
  });

  it('false when the API key is missing', () => {
    mockConfig.apiKey = '';
    expect(axes4PacService.isAvailable()).toBe(false);
  });

  it('false when the subscription ID is missing', () => {
    mockConfig.subscriptionId = '';
    expect(axes4PacService.isAvailable()).toBe(false);
  });
});

describe('validate', () => {
  it('returns ran:false without any HTTP call when not configured', async () => {
    mockConfig.apiKey = '';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result).toEqual({ ran: false, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ran:false without any HTTP call when the local quota tracker refuses admission', async () => {
    vi.mocked(axes4QuotaService.tryReservePages).mockResolvedValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result).toEqual({ ran: false, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reserves the real local page count before submitting', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', name: 't.pdf', reports: [{ type: 'PDF/UA', uaIndex: 85.3 }] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', issues: [] } }));
    vi.stubGlobal('fetch', fetchSpy);

    await axes4PacService.validate(await makePdfBuffer(3), 'test.pdf');

    expect(axes4QuotaService.tryReservePages).toHaveBeenCalledWith(3);
  });

  it('submits the PDF then fetches details, returning parsed failures and uaIndex on success', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', name: 't.pdf', reports: [{ type: 'PDF/UA', uaIndex: 85.3 }] } }))
      .mockResolvedValueOnce(jsonResponse({
        body: {
          jobId: 'job-1',
          issues: [
            {
              type: 'PDF/UA',
              issues: [
                {
                  issueId: 'issue-1',
                  severity: 'Error',
                  severityId: 0,
                  checkId: 'check-abc',
                  caption: 'Missing alt text',
                  count: 3,
                  details: [{ pageIndex: 4, rectangle: { top: 10, bottom: 20, left: 30, right: 40 } }],
                },
              ],
            },
          ],
        },
      }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result.ran).toBe(true);
    expect(result.uaIndex).toBe(85.3);
    expect(result.failures).toEqual([
      {
        checkId: 'check-abc',
        description: 'Missing alt text',
        pageNumber: 5, // pageIndex 4 -> 1-based 5
        rectangle: { top: 10, bottom: 20, left: 30, right: 40 },
        count: 3,
      },
    ]);

    // Submit call: raw octet-stream body, x-api-key header, subscription in the URL.
    const submitCall = fetchSpy.mock.calls[0];
    expect(submitCall[0]).toContain('/v3/subscription/test-subscription/jobs?');
    expect(submitCall[0]).toContain('checksets=pdfua');
    expect((submitCall[1] as RequestInit).method).toBe('POST');
    expect((submitCall[1] as RequestInit).headers).toMatchObject({ 'x-api-key': 'test-key' });

    // Details call: uses the jobId the submit call returned.
    const detailsCall = fetchSpy.mock.calls[1];
    expect(detailsCall[0]).toContain('/v3/subscription/test-subscription/jobs/job-1/report/details');
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'page limit'],
    [413, 'too large'],
    [422, 'invalid'],
  ])('degrades to ran:false (not a throw) on a documented %i response', async (status) => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result).toEqual({ ran: false, failures: [] });
  });

  it('retries once on a 5xx then succeeds', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', name: 't.pdf', reports: [] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', issues: [] } }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result.ran).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('degrades to ran:false when the request times out', async () => {
    mockConfig.timeoutMs = 10;
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result).toEqual({ ran: false, failures: [] });
  });

  it('does not flag a document with no issues -- empty failures array, ran:true', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', name: 't.pdf', reports: [] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { jobId: 'job-1', issues: [] } }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await axes4PacService.validate(await makePdfBuffer(), 'test.pdf');

    expect(result).toEqual({ ran: true, failures: [], uaIndex: undefined });
  });
});
