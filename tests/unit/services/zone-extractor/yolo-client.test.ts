import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectWithYolo } from '../../../../src/services/zone-extractor/yolo-client';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.YOLO_SERVICE_URL = 'http://localhost:9999';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

describe('detectWithYolo', () => {
  it('throws when YOLO_SERVICE_URL is missing', async () => {
    delete process.env.YOLO_SERVICE_URL;
    await expect(detectWithYolo('/t.pdf', 'j1')).rejects.toThrow(
      'YOLO_SERVICE_URL env var is not set',
    );
  });

  it('submit 4xx → YOLO_CLIENT_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('bad request', { status: 422 }),
    );
    await expect(detectWithYolo('/t.pdf', 'j1')).rejects.toThrow('YOLO_CLIENT_ERROR');
  });

  it('submit 5xx → YOLO_SERVICE_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 503 }),
    );
    await expect(detectWithYolo('/t.pdf', 'j1')).rejects.toThrow('YOLO_SERVICE_ERROR');
  });

  it('submit + poll → returns the COMPLETED result', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ asyncJobId: 'a1', status: 'PROCESSING' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          asyncJobId: 'a1',
          status: 'COMPLETED',
          result: {
            jobId: 'j1',
            zones: [{ page: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'formula', confidence: 0.9 }],
            processingTimeMs: 42,
          },
        }), { status: 200 }),
      );

    const p = detectWithYolo('/t.pdf', 'j1');
    await vi.advanceTimersByTimeAsync(5_000); // clear the poll interval
    const res = await p;

    expect(res.zones).toHaveLength(1);
    expect(res.zones[0].label).toBe('formula');
    expect(res.processingTimeMs).toBe(42);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('poll FAILED → YOLO_SERVICE_ERROR with the service message', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ asyncJobId: 'a1', status: 'PROCESSING' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ asyncJobId: 'a1', status: 'FAILED', error: 'render failed' }), { status: 200 }),
      );

    const p = detectWithYolo('/t.pdf', 'j1');
    p.catch(() => {}); // avoid an unhandled rejection while timers advance
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).rejects.toThrow('YOLO_SERVICE_ERROR: render failed');
  });
});
