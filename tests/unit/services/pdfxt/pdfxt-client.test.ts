import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectWithPdfxt,
  mapPdfxtLabel,
  type PdfxtServiceResponse,
} from '../../../../src/services/pdfxt/pdfxt-client';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.PDFXT_SERVICE_URL = 'http://localhost:9999';
  process.env.PDFXT_API_KEY = 'test-key';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('detectWithPdfxt', () => {
  it('happy path: returns zones', async () => {
    const mockResponse: PdfxtServiceResponse = {
      jobId: 'job-1',
      zones: [
        { pageNumber: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'text', confidence: 0.9 },
      ],
      processingTimeMs: 200,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await detectWithPdfxt('/test.pdf', 'job-1');
    expect(result.jobId).toBe('job-1');
    expect(result.zones).toHaveLength(1);
  });

  it('throws when PDFXT_SERVICE_URL missing', async () => {
    delete process.env.PDFXT_SERVICE_URL;
    await expect(detectWithPdfxt('/test.pdf', 'job-1')).rejects.toThrow(
      'PDFXT_SERVICE_URL env var is not set',
    );
  });

  it('422 response → PDFXT_CLIENT_ERROR, fetch called once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('bad request', { status: 422 }),
    );

    await expect(detectWithPdfxt('/test.pdf', 'job-1')).rejects.toThrow(
      'PDFXT_CLIENT_ERROR',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('503 response → retries 3 times, throws PDFXT_SERVICE_ERROR', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }));

    await expect(detectWithPdfxt('/test.pdf', 'job-1')).rejects.toThrow(
      'PDFXT_SERVICE_ERROR',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('AbortError → PDFXT_TIMEOUT, no retry', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

    await expect(detectWithPdfxt('/test.pdf', 'job-1')).rejects.toThrow(
      'PDFXT_TIMEOUT',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('mapPdfxtLabel', () => {
  it.each([
    ['text', 'paragraph'],
    ['heading', 'section-header'],
    ['table', 'table'],
    ['figure', 'figure'],
    ['caption', 'caption'],
    ['footnote', 'footnote'],
    ['header', 'header'],
    ['footer', 'footer'],
    ['list', 'paragraph'],
    ['list-item', 'paragraph'],
  ] as const)('maps "%s" → "%s"', (label, expected) => {
    expect(mapPdfxtLabel(label)).toBe(expected);
  });

  it('unknown label → paragraph + console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapPdfxtLabel('unknown-thing')).toBe('paragraph');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown-thing'),
    );
    warnSpy.mockRestore();
  });

  it('case insensitive: "HEADING" → section-header', () => {
    expect(mapPdfxtLabel('HEADING')).toBe('section-header');
  });
});
