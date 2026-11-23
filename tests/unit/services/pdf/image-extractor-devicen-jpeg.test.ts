/**
 * QC brief Theme B1b (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md,
 * F-13): convertToBase64's jpeg branch previously only checked the JPEG SOI
 * marker and returned the raw bytes -- a one-channel DeviceN/Separation
 * /Black JPEG's samples are ink amounts, not light amounts, so the raw
 * bytes show an inverted image to a vision model. Exercises the real sharp
 * decode/re-encode path with a genuine JPEG buffer, not a mocked one.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';

// convertToBase64 is private; exercise via cast, same pattern as
// ai-analysis-figure-crop-render.test.ts's own fallbackToPageRender access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = imageExtractorService as any;

/** A real, uniform-value 8x8 one-channel (grayscale) JPEG -- a single flat
 * tint value, encoded as an actual JPEG via sharp so the real decode path
 * (not a stub) is exercised. Uniform rather than a spatial ink/no-ink
 * pattern: at this tiny a resolution, JPEG's own lossy 8x8-DCT block
 * compression can smear a spatial pattern enough to make per-pixel
 * assertions flaky; a flat value survives compression reliably. */
async function makeOneChannelJpeg(tint: number): Promise<Buffer> {
  const raw = Buffer.alloc(64, tint);
  return sharp(raw, { raw: { width: 8, height: 8, channels: 1 } }).jpeg({ quality: 100 }).toBuffer();
}

async function decodedGrayValue(base64: string): Promise<number> {
  const png = Buffer.from(base64, 'base64');
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return data[0]; // RGB, equal channels for a converted grayscale/separation image
}

describe('convertToBase64: DeviceN/Separation JPEG decode', () => {
  it('inverts a /Black separation JPEG (ink amount -> light amount) before returning it', async () => {
    const jpeg = await makeOneChannelJpeg(10); // near-full ink

    const base64 = await svc.convertToBase64(
      new Uint8Array(jpeg), 'jpeg', 8, 8, 1024, 8, { kind: 'separation' }, null, true
    );

    expect(base64).toBeTruthy();
    // Raw sample ~10 (near-full ink) must become near-WHITE after inversion.
    expect(await decodedGrayValue(base64)).toBeGreaterThan(200);
  });

  it('does NOT invert when invertSeparationTint is false (the image\'s own /Decode [1 0] already reversed it)', async () => {
    const jpeg = await makeOneChannelJpeg(10);

    const base64 = await svc.convertToBase64(
      new Uint8Array(jpeg), 'jpeg', 8, 8, 1024, 8, { kind: 'separation' }, null, false
    );

    expect(base64).toBeTruthy();
    // No inversion -- raw sample ~10 stays near-black.
    expect(await decodedGrayValue(base64)).toBeLessThan(55);
  });

  it('returns the raw JPEG bytes unchanged when colorSpaceInfo is not separation (e.g. a normal RGB photo)', async () => {
    const rgbRaw = Buffer.from([200, 100, 50, 10, 20, 30, 1, 2, 3, 4, 5, 6]); // 2x2 RGB
    const jpeg = await sharp(rgbRaw, { raw: { width: 2, height: 2, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();

    const base64 = await svc.convertToBase64(new Uint8Array(jpeg), 'jpeg', 2, 2, 1024, 8, { kind: 'rgb' }, null, true);

    expect(base64).toBe(Buffer.from(jpeg).toString('base64'));
  });
});
