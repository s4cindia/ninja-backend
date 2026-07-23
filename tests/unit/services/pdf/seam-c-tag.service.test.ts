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
    ...overrides,
  };
}

describe('SeamCTagService.tagPdf', () => {
  const svc = new SeamCTagService();

  it('detects → builds a StructTree and returns an Adobe-shaped result', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps();
    const res = await svc.tagPdf(buf, 'job1', deps);

    expect(res.source).toBe('seam-c');
    expect(res.reportBuffer).toBeNull();
    expect(res.wordBuffer).toBeNull();
    expect(res.parsedFlags).toEqual([]);
    expect(res.buildResult.elements).toBeGreaterThan(0);
    expect(res.buildResult.mcids).toBeGreaterThan(0);

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

  it('throws SEAM_C_NO_ZONES when the detector returns nothing (temp still cleaned)', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ detect: vi.fn(async () => ({ zones: [] })) });
    await expect(svc.tagPdf(buf, 'job2', deps)).rejects.toThrow(/SEAM_C_NO_ZONES/);
    expect(deps.deleteTemp).toHaveBeenCalledOnce();
    expect(deps.touchIdle).toHaveBeenCalledOnce();
  });

  it('cleans up the temp object and re-arms idle even if detection throws', async () => {
    const buf = await makeUntaggedPdf();
    const deps = mockDeps({ detect: vi.fn(async () => { throw new Error('YOLO_TIMEOUT'); }) });
    await expect(svc.tagPdf(buf, 'job3', deps)).rejects.toThrow(/YOLO_TIMEOUT/);
    expect(deps.deleteTemp).toHaveBeenCalledOnce();
    expect(deps.touchIdle).toHaveBeenCalledOnce();
  });
});
