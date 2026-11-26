import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
import { SeamCTagService, type SeamCDeps } from '../../../../src/services/pdf/seam-c-tag.service';

const H = 600;
async function makeUntaggedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([450, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Heading', { x: 50, y: 558, size: 16, font });   // baseline in [550,570]
  page.drawText('Body paragraph.', { x: 50, y: 520, size: 12, font }); // baseline in [510,530]
  return Buffer.from(await doc.save());
}

// zones the (mocked) detector returns — bands chosen to contain the baselines above
const DETECT_RESPONSE = {
  zones: [
    { page: 1, bbox: { x: 50, y: 30, w: 400, h: 20 }, label: 'section-header' }, // band [550,570]
    { page: 1, bbox: { x: 50, y: 70, w: 400, h: 20 }, label: 'paragraph' },      // band [510,530]
  ],
};

function mockDeps(overrides: Partial<SeamCDeps> = {}): SeamCDeps {
  return {
    ensureUp: vi.fn(async () => {}),
    touchIdle: vi.fn(),
    detect: vi.fn(async () => DETECT_RESPONSE),
    uploadTemp: vi.fn(async () => 's3://bucket/seam-c-temp/job.pdf'),
    deleteTemp: vi.fn(async () => {}),
    cacheLookup: vi.fn(async () => ({ hit: false, cacheKeyPrefix: 'default-key' })),
    cacheStore: vi.fn(async () => ({ outcome: 'stored' as const, cacheKeyPrefix: 'default-key' })),
    ...overrides,
  };
}

describe('SeamCTagService.tagPdf', () => {
  const svc = new SeamCTagService();

  it('detects → builds a StructTree and returns an Adobe-shaped result', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps();
    const res = await svc.tagPdf(buf, 'job1', undefined, deps);

    expect(res.source).toBe('seam-c');
    expect(res.reportBuffer).toBeNull();
    expect(res.wordBuffer).toBeNull();
    expect(res.parsedFlags).toEqual([]);
    expect(res.buildResult.elements).toBeGreaterThan(0);
    expect(res.buildResult.mcids).toBeGreaterThan(0);

    // elementCounts is a real per-zone-type tally from the detector's own
    // classification, keyed by canonical zone type (not Adobe's shape)
    expect(res.elementCounts).toEqual({ 'section-header': 1, paragraph: 1 });

    // the returned buffer is a genuinely tagged PDF
    const reloaded = await PDFDocument.load(res.taggedPdfBuffer);
    expect(reloaded.catalog.get(PDFName.of('StructTreeRoot'))).toBeTruthy();
    expect(reloaded.catalog.get(PDFName.of('MarkInfo'))).toBeTruthy();

    // lifecycle: scaled the GPU up, staged+cleaned a temp object, re-armed idle
    expect(deps.ensureUp).toHaveBeenCalledOnce();
    expect(deps.uploadTemp).toHaveBeenCalledOnce();
    expect(deps.detect).toHaveBeenCalledWith('s3://bucket/seam-c-temp/job.pdf', 'job1');
    expect(deps.deleteTemp).toHaveBeenCalledWith('s3://bucket/seam-c-temp/job.pdf');
    expect(deps.touchIdle).toHaveBeenCalledOnce();
  });

  it('does not count a figure zone the struct-tree builder dropped for having no bound content', async () => {
    // Real incident (Curiel title page): the detector flagged a "figure" zone
    // over blank page space (no text/image there). struct-tree-builder.ts
    // correctly drops it from the tree, but elementCounts must not still
    // report it -- that would over-count zones that were never actually
    // tagged as structure.
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({
      detect: vi.fn(async () => ({
        zones: [
          ...DETECT_RESPONSE.zones,
          { page: 1, bbox: { x: 50, y: 300, w: 400, h: 20 }, label: 'figure' }, // blank region
        ],
      })),
    });
    const res = await svc.tagPdf(buf, 'job4', undefined, deps);

    expect(res.elementCounts).toEqual({ 'section-header': 1, paragraph: 1 });
    expect(res.elementCounts.figure).toBeUndefined();
  });

  it('throws SEAM_C_NO_ZONES when the detector returns nothing (temp still cleaned)', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ detect: vi.fn(async () => ({ zones: [] })) });
    await expect(svc.tagPdf(buf, 'job2', undefined, deps)).rejects.toThrow(/SEAM_C_NO_ZONES/);
    expect(deps.deleteTemp).toHaveBeenCalledOnce();
    expect(deps.touchIdle).toHaveBeenCalledOnce();
  });

  it('cleans up the temp object and re-arms idle even if detection throws', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ detect: vi.fn(async () => { throw new Error('YOLO_TIMEOUT'); }) });
    await expect(svc.tagPdf(buf, 'job3', undefined, deps)).rejects.toThrow(/YOLO_TIMEOUT/);
    expect(deps.deleteTemp).toHaveBeenCalledOnce();
    expect(deps.touchIdle).toHaveBeenCalledOnce();
  });
});

describe('SeamCTagService.tagPdf -- zone-detection cache', () => {
  // Real bug this closes (2026-11-26, see git log): the SAME source PDF,
  // detected by the SAME model/params, produced a DIFFERENT Figure count
  // across two full-pipeline runs of the identical commit -- GPU inference
  // has no determinism guarantee by default. A cache HIT must skip the GPU
  // path entirely (not just return faster) -- see ensureUp/uploadTemp/
  // detect/deleteTemp/touchIdle's own lifecycle assertions below.
  const svc = new SeamCTagService();

  it('is never consulted when no tenantId is provided (caching is strictly opt-in)', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps();
    await svc.tagPdf(buf, 'job5', undefined, deps);
    expect(deps.cacheLookup).not.toHaveBeenCalled();
    expect(deps.cacheStore).not.toHaveBeenCalled();
    expect(deps.detect).toHaveBeenCalledOnce();
  });

  /**
   * Verified this test fails (ensureUp/detect/etc. still get called) against
   * a version of tagPdf with the cache-hit branch removed (always falls
   * through to detection), before confirming it passes against the real
   * hit-skips-the-GPU-path behavior.
   */
  it('on a cache hit, uses the cached zones, skips the entire GPU lifecycle, and reports outcome "hit"', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ cacheLookup: vi.fn(async () => ({ hit: true, cacheKeyPrefix: 'abc123', zones: DETECT_RESPONSE.zones })) });

    const res = await svc.tagPdf(buf, 'job6', 'tenant-1', deps);

    expect(res.elementCounts).toEqual({ 'section-header': 1, paragraph: 1 });
    expect(res.zoneDetectionCache).toEqual({ outcome: 'hit', cacheKeyPrefix: 'abc123' });
    expect(deps.cacheLookup).toHaveBeenCalledWith('tenant-1', buf);
    expect(deps.ensureUp).not.toHaveBeenCalled();
    expect(deps.uploadTemp).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.deleteTemp).not.toHaveBeenCalled();
    expect(deps.touchIdle).not.toHaveBeenCalled();
    expect(deps.cacheStore).not.toHaveBeenCalled();
  });

  it('on a cache miss, detects normally, stores the result under the same tenantId, and reports the stored key', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({
      cacheLookup: vi.fn(async () => ({ hit: false, cacheKeyPrefix: 'miss-key' })),
      detect: vi.fn(async () => ({ ...DETECT_RESPONSE, modelInfo: { weightsSha256: 'sha-of-weights' } })),
      cacheStore: vi.fn(async () => ({ outcome: 'stored' as const, cacheKeyPrefix: 'stored-key' })),
    });

    const res = await svc.tagPdf(buf, 'job7', 'tenant-1', deps);

    expect(deps.cacheLookup).toHaveBeenCalledWith('tenant-1', buf);
    expect(deps.ensureUp).toHaveBeenCalledOnce();
    expect(deps.detect).toHaveBeenCalledOnce();
    expect(deps.cacheStore).toHaveBeenCalledWith('tenant-1', buf, DETECT_RESPONSE.zones, 'sha-of-weights');
    expect(res.zoneDetectionCache).toEqual({ outcome: 'miss', cacheKeyPrefix: 'stored-key' });
  });

  it('degrades gracefully (detects normally) and reports "lookup_failed" when the cache lookup itself throws', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ cacheLookup: vi.fn(async () => { throw new Error('SSM unreachable'); }) });

    const res = await svc.tagPdf(buf, 'job8', 'tenant-1', deps);

    expect(res.elementCounts).toEqual({ 'section-header': 1, paragraph: 1 });
    expect(res.zoneDetectionCache).toEqual({ outcome: 'lookup_failed', error: 'SSM unreachable' });
    expect(deps.detect).toHaveBeenCalledOnce();
  });

  it('degrades gracefully (still returns the tagged result) and reports "store_failed" when the cache store itself throws', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({
      cacheLookup: vi.fn(async () => ({ hit: false, cacheKeyPrefix: 'miss-key' })),
      cacheStore: vi.fn(async () => { throw new Error('DB unreachable'); }),
    });

    const res = await svc.tagPdf(buf, 'job9', 'tenant-1', deps);

    expect(res.elementCounts).toEqual({ 'section-header': 1, paragraph: 1 });
    expect(res.zoneDetectionCache).toEqual({ outcome: 'store_failed', error: 'DB unreachable' });
  });

  it('reports outcome "skipped_no_tenant" when no tenantId is provided', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps();

    const res = await svc.tagPdf(buf, 'job10', undefined, deps);

    expect(res.zoneDetectionCache).toEqual({ outcome: 'skipped_no_tenant' });
    expect(deps.cacheLookup).not.toHaveBeenCalled();
    expect(deps.cacheStore).not.toHaveBeenCalled();
  });
});
