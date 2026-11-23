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

/** A real, genuinely 3-channel-encoded JPEG whose pixels happen to be
 * grayscale (R=G=B) -- the real-world shape that broke live on Karsaklian
 * (QC brief Theme B regression report, 2026-11-24): a producer emitted a
 * declared single-colorant /DeviceN [/Black] image as a standard 3-
 * component JPEG, not a true 1-component one. Built by encoding genuinely
 * 3-channel raw data (never 1-channel raw reinterpreted), so sharp's own
 * decoder really does report channels:3 for this fixture -- confirmed by
 * the first assertion below, not assumed. Synthetic end-to-end: no bytes
 * from the real Karsaklian file are used anywhere. */
async function makeThreeChannelGrayscaleJpeg(tint: number): Promise<Buffer> {
  const raw = Buffer.alloc(8 * 8 * 3, tint);
  return sharp(raw, { raw: { width: 8, height: 8, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
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

  it('correctly inverts a single-colorant image even when sharp decodes its JPEG as 3 channels, not 1 (real-world DeviceN encoding shape, not the synthetic 1-channel case above)', async () => {
    const jpeg = await makeThreeChannelGrayscaleJpeg(10); // near-full ink

    // Confirm the premise first: this fixture's own JPEG really does decode
    // as 3 channels via sharp's raw(), not 1 -- otherwise this test
    // wouldn't be exercising the real bug shape at all.
    const { info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);

    const base64 = await svc.convertToBase64(
      new Uint8Array(jpeg), 'jpeg', 8, 8, 1024, 8, { kind: 'separation' }, null, true
    );

    expect(base64).toBeTruthy();
    // Same near-full-ink-inverts-to-near-white assertion as the 1-channel
    // case -- must hold regardless of sharp's own decoded channel count.
    expect(await decodedGrayValue(base64)).toBeGreaterThan(200);
  });

  it('returns the raw JPEG bytes unchanged when colorSpaceInfo is not separation (e.g. a normal RGB photo)', async () => {
    const rgbRaw = Buffer.from([200, 100, 50, 10, 20, 30, 1, 2, 3, 4, 5, 6]); // 2x2 RGB
    const jpeg = await sharp(rgbRaw, { raw: { width: 2, height: 2, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();

    const base64 = await svc.convertToBase64(new Uint8Array(jpeg), 'jpeg', 2, 2, 1024, 8, { kind: 'rgb' }, null, true);

    expect(base64).toBe(Buffer.from(jpeg).toString('base64'));
  });
});
