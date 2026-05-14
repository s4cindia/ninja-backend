import { describe, it, expect } from 'vitest';
import { validatePrhImageAssets } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/image-assets-validator';
import type {
  PrhImageAssetsInput,
  PrhImageMetadata,
  PrhXhtmlFile,
} from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function image(
  path: string,
  opts: Partial<PrhImageMetadata> = {},
): PrhImageMetadata {
  return {
    path,
    mediaType: opts.mediaType ?? 'image/jpeg',
    width: opts.width ?? 1900,
    height: opts.height ?? 2400,
    density: opts.density ?? 300,
    colorSpace: opts.colorSpace ?? 'srgb',
    colorCount: opts.colorCount ?? null,
    sizeBytes: opts.sizeBytes ?? 400_000,
    isCover: opts.isCover ?? false,
  };
}

function xhtmlFile(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body>${body}</body>
</html>`,
  };
}

function input(opts: {
  images?: PrhImageMetadata[];
  xhtmlFiles?: PrhXhtmlFile[];
} = {}): PrhImageAssetsInput {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles: opts.xhtmlFiles ?? [],
    images: opts.images ?? [],
  };
}

describe('validatePrhImageAssets — PRH-IMG-CAPTURE-SIZE-WRONG', () => {
  it('emits when an image referenced by .portrait_large is not 1900px ±5%', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [image('EPUB/images/diagram.jpg', { width: 1600 })],
        xhtmlFiles: [
          xhtmlFile(
            'EPUB/xhtml/chapter_001.xhtml',
            '<img class="portrait_large" src="../images/diagram.jpg" alt=""/>',
          ),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(true);
  });

  it('does NOT emit when the width is within the 5% tolerance', () => {
    const issues = validatePrhImageAssets(
      input({
        // 1900px ±95px = 1805..1995
        images: [image('EPUB/images/diagram.jpg', { width: 1850 })],
        xhtmlFiles: [
          xhtmlFile(
            'EPUB/xhtml/chapter_001.xhtml',
            '<img class="portrait_large" src="../images/diagram.jpg" alt=""/>',
          ),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(false);
  });

  it('treats image_full* classes as 1900px (prefix match)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [image('EPUB/images/hero.jpg', { width: 1200 })],
        xhtmlFiles: [
          xhtmlFile(
            'EPUB/xhtml/chapter_001.xhtml',
            '<img class="image_full_caption_landscape" src="../images/hero.jpg" alt=""/>',
          ),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(true);
  });

  it('does NOT emit when the host class does not map to a canonical capture size', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [image('EPUB/images/diagram.jpg', { width: 500 })],
        xhtmlFiles: [
          xhtmlFile(
            'EPUB/xhtml/chapter_001.xhtml',
            '<img class="custom_diagram" src="../images/diagram.jpg" alt=""/>',
          ),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(false);
  });

  it('does NOT emit when no <img> in the EPUB references the image', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [image('EPUB/images/orphan.jpg', { width: 500 })],
        xhtmlFiles: [],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(false);
  });

  it('handles space-separated class tokens (.portrait_large among others)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [image('EPUB/images/diagram.jpg', { width: 500 })],
        xhtmlFiles: [
          xhtmlFile(
            'EPUB/xhtml/chapter_001.xhtml',
            '<img class="caption_above portrait_large no_indent" src="../images/diagram.jpg" alt=""/>',
          ),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-CAPTURE-SIZE-WRONG')).toBe(true);
  });
});

describe('validatePrhImageAssets — PRH-IMG-DPI-TOO-LOW', () => {
  it('emits when density is below 300', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { density: 200 })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-DPI-TOO-LOW')).toBe(true);
  });

  it('does NOT emit when density is exactly 300', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { density: 300 })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-DPI-TOO-LOW')).toBe(false);
  });

  it('does NOT emit when density is null (EXIF stripped)', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { density: null })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-DPI-TOO-LOW')).toBe(false);
  });
});

describe('validatePrhImageAssets — PRH-IMG-COLORSPACE-NOT-SRGB', () => {
  it('emits when colorSpace is CMYK', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { colorSpace: 'cmyk' })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-COLORSPACE-NOT-SRGB')).toBe(true);
  });

  it('does NOT emit when colorSpace is srgb (any case)', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { colorSpace: 'sRGB' })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-COLORSPACE-NOT-SRGB')).toBe(false);
  });

  it('does NOT emit when colorSpace is null', () => {
    const issues = validatePrhImageAssets(
      input({ images: [image('EPUB/images/x.jpg', { colorSpace: null })] }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-COLORSPACE-NOT-SRGB')).toBe(false);
  });
});

describe('validatePrhImageAssets — PRH-IMG-PNG-EXPECTED-JPEG', () => {
  it('emits for a small low-colour JPEG (line-drawing heuristic)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/diagram.jpg', { width: 600, height: 400, colorCount: 32 }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-PNG-EXPECTED-JPEG')).toBe(true);
  });

  it('does NOT emit when width > 800 (photo-sized)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/photo.jpg', { width: 1900, height: 1200, colorCount: 32 }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-PNG-EXPECTED-JPEG')).toBe(false);
  });

  it('does NOT emit when colorCount > 256 (full-colour content)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/thumb.jpg', { width: 600, height: 400, colorCount: 5000 }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-PNG-EXPECTED-JPEG')).toBe(false);
  });

  it('does NOT emit for PNGs (rule is JPEG-only)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/diagram.png', {
            mediaType: 'image/png',
            width: 600,
            height: 400,
            colorCount: 32,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-PNG-EXPECTED-JPEG')).toBe(false);
  });

  it('does NOT emit when colorCount is null (heuristic skipped)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/diagram.jpg', {
            width: 600,
            height: 400,
            colorCount: null,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-PNG-EXPECTED-JPEG')).toBe(false);
  });
});

describe('validatePrhImageAssets — PRH-IMG-JPEG-QUALITY-SUSPECT', () => {
  it('emits when bytes-per-pixel exceeds 0.5', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          // 1000 * 1000 = 1e6 px, 700KB ≈ 0.7 bytes/px → over threshold
          image('EPUB/images/photo.jpg', {
            width: 1000,
            height: 1000,
            sizeBytes: 700_000,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-JPEG-QUALITY-SUSPECT')).toBe(true);
  });

  it('does NOT emit at or below 0.5 bytes/pixel', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          // 1000 * 1000 = 1e6 px, 400KB ≈ 0.4 bytes/px → under threshold
          image('EPUB/images/photo.jpg', {
            width: 1000,
            height: 1000,
            sizeBytes: 400_000,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-JPEG-QUALITY-SUSPECT')).toBe(false);
  });

  it('exempts the cover image', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/cover.jpg', {
            width: 1000,
            height: 1000,
            sizeBytes: 900_000,
            isCover: true,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-JPEG-QUALITY-SUSPECT')).toBe(false);
  });

  it('does NOT emit for PNGs (rule is JPEG-only)', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/diagram.png', {
            mediaType: 'image/png',
            width: 1000,
            height: 1000,
            sizeBytes: 900_000,
          }),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-IMG-JPEG-QUALITY-SUSPECT')).toBe(false);
  });
});

describe('validatePrhImageAssets — overall', () => {
  it('emits zero issues for a conformant image', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          image('EPUB/images/cover.jpg', {
            width: 1900,
            height: 2400,
            density: 300,
            colorSpace: 'srgb',
            sizeBytes: 400_000,
            isCover: true,
          }),
        ],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('skips non-image manifest entries', () => {
    const issues = validatePrhImageAssets(
      input({
        images: [
          {
            path: 'EPUB/styles/basestyles.css',
            mediaType: 'text/css',
            width: null,
            height: null,
            density: null,
            colorSpace: null,
            colorCount: null,
            sizeBytes: 1000,
            isCover: false,
          },
        ],
      }),
    );
    expect(issues).toEqual([]);
  });
});
