import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFString } from 'pdf-lib';
import {
  resolveColorSpaceInfo,
  decodeStreamBytes,
  convertSamplesToRgb,
  channelsFor,
  type ColorSpaceInfo,
} from '../../../../src/services/pdf/image-extractor.service';

/**
 * Built to fix a real, previously-undiscovered bug found live against
 * Math_Kim's real image data (a 1,313-image survey): convertToBase64
 * always assumed 3-channel RGB raw pixel samples regardless of the image's
 * real /ColorSpace, AND fed still-Filter-encoded (never decompressed)
 * bytes straight into sharp's raw-pixel decoder. Confirmed real
 * distribution: 69%+14% direct DeviceCMYK, 3% single-colorant DeviceN
 * (`/DeviceN [/Black] /DeviceCMYK ...`, a common prepress convention for
 * simulating plain black ink via a spot color), 1% Indexed with a CMYK
 * base -- 88% of all real images, and the direct root cause of most of the
 * 42 real remaining MATTERHORN-13-001 (missing alt-text) issues never
 * getting a usable image for Gemini to describe at all.
 */

describe('convertSamplesToRgb', () => {
  it('passes RGB samples through unchanged (aside from trimming to pixelCount*3)', () => {
    const samples = Uint8Array.from([10, 20, 30, 40, 50, 60, 99]); // 2 pixels + trailing garbage
    const rgb = convertSamplesToRgb(samples, { kind: 'rgb' }, 2);
    expect(Array.from(rgb!)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('expands a single gray channel into equal R=G=B', () => {
    const samples = Uint8Array.from([0, 128, 255]);
    const rgb = convertSamplesToRgb(samples, { kind: 'gray' }, 3);
    expect(Array.from(rgb!)).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
  });

  it('converts CMYK to RGB using the standard formula', () => {
    // Pure black (K=255, C=M=Y=0) -> RGB black.
    // Pure white (all 0) -> RGB white.
    // Pure cyan (C=255, rest 0) -> R=0, G=255, B=255.
    const samples = Uint8Array.from([
      0, 0, 0, 255, // black
      0, 0, 0, 0,   // white
      255, 0, 0, 0, // cyan
    ]);
    const rgb = convertSamplesToRgb(samples, { kind: 'cmyk' }, 3);
    expect(Array.from(rgb!)).toEqual([
      0, 0, 0,
      255, 255, 255,
      0, 255, 255,
    ]);
  });

  it('inverts a single-colorant separation/DeviceN tint (0 tint = white, full tint = the colorant\'s color)', () => {
    // Confirmed real case: /DeviceN [/Black] -- tint 0 means no ink (white
    // page shows through), tint 255 means full-strength black ink.
    const samples = Uint8Array.from([0, 128, 255]);
    const rgb = convertSamplesToRgb(samples, { kind: 'separation' }, 3);
    expect(Array.from(rgb!)).toEqual([255, 255, 255, 127, 127, 127, 0, 0, 0]);
  });

  it('expands an Indexed image via its lookup table into the base colorspace, then converts that to RGB', () => {
    // 2-entry CMYK palette: index 0 = pure cyan, index 1 = pure black.
    const lookup = Uint8Array.from([255, 0, 0, 0, /* cyan */ 0, 0, 0, 255 /* black */]);
    const info: ColorSpaceInfo = { kind: 'indexed', base: { kind: 'cmyk' }, lookup };
    const indices = Uint8Array.from([0, 1, 0]); // cyan, black, cyan
    const rgb = convertSamplesToRgb(indices, info, 3);
    expect(Array.from(rgb!)).toEqual([
      0, 255, 255, // cyan
      0, 0, 0,     // black
      0, 255, 255, // cyan
    ]);
  });

  it('returns null when samples are shorter than the colorspace requires, rather than reading out of bounds', () => {
    expect(convertSamplesToRgb(Uint8Array.from([1, 2]), { kind: 'cmyk' }, 3)).toBeNull();
    expect(convertSamplesToRgb(Uint8Array.from([1]), { kind: 'rgb' }, 1)).toBeNull();
  });

  it('declines an Indexed image whose base colorspace channelsFor cannot determine (defensive, unreachable via resolveColorSpaceInfo today)', () => {
    const bogusBase = { kind: 'unknown' } as unknown as ColorSpaceInfo;
    const info: ColorSpaceInfo = { kind: 'indexed', base: bogusBase, lookup: Uint8Array.from([0]) };
    expect(convertSamplesToRgb(Uint8Array.from([0]), info, 1)).toBeNull();
  });
});

describe('channelsFor', () => {
  it('reports the right channel count per resolved colorspace kind', () => {
    expect(channelsFor({ kind: 'gray' })).toBe(1);
    expect(channelsFor({ kind: 'rgb' })).toBe(3);
    expect(channelsFor({ kind: 'cmyk' })).toBe(4);
    expect(channelsFor({ kind: 'separation' })).toBe(1);
    expect(channelsFor({ kind: 'indexed', base: { kind: 'cmyk' }, lookup: new Uint8Array() })).toBe(1);
  });
});

describe('decodeStreamBytes', () => {
  async function buildRawStream(
    contents: Uint8Array,
    filter?: string,
    decodeParms?: { Predictor: number; Colors?: number; Columns?: number }
  ): Promise<PDFRawStream> {
    const doc = await PDFDocument.create();
    const dictObj: Record<string, unknown> = {};
    if (filter) dictObj.Filter = PDFName.of(filter);
    if (decodeParms) dictObj.DecodeParms = decodeParms;
    const dict = doc.context.obj(dictObj);
    return PDFRawStream.of(dict, contents);
  }

  it('returns the raw bytes unchanged when there is no /Filter at all', async () => {
    const raw = Uint8Array.from([1, 2, 3, 4]);
    const stream = await buildRawStream(raw);
    expect(decodeStreamBytes(stream)).toEqual(raw);
  });

  it('inflates real FlateDecode-compressed bytes back to the original', async () => {
    const original = Uint8Array.from(Buffer.from('hello world, this is real pixel-ish data'));
    const compressed = zlib.deflateSync(Buffer.from(original));
    const stream = await buildRawStream(compressed, 'FlateDecode');
    const decoded = decodeStreamBytes(stream);
    expect(Buffer.from(decoded!).toString()).toBe(Buffer.from(original).toString());
  });

  it('declines (returns null) an unsupported filter rather than guessing', async () => {
    const stream = await buildRawStream(Uint8Array.from([1, 2, 3]), 'LZWDecode');
    expect(decodeStreamBytes(stream)).toBeNull();
  });

  // Real, previously-undiscovered bug found live against Math_Weir_PDF.pdf:
  // /Filter [/FlateDecode] (a legal, spec-equivalent single-element array
  // some producers always emit even for one filter) was compared against
  // the bare Name '/FlateDecode' via a raw .toString(), which produced
  // "[ /FlateDecode ]" and never matched -- the image was silently treated
  // as an unsupported format and never decompressed at all.
  describe('array-wrapped /Filter (CodeRabbit/live-data finding)', () => {
    async function buildRawStreamWithFilterArray(contents: Uint8Array, filterNames: string[]): Promise<PDFRawStream> {
      const doc = await PDFDocument.create();
      const dict = doc.context.obj({
        Filter: filterNames.map((f) => PDFName.of(f)),
      });
      return PDFRawStream.of(dict, contents);
    }

    it('inflates real FlateDecode-compressed bytes when /Filter is a single-element array', async () => {
      const original = Uint8Array.from(Buffer.from('hello world, this is real pixel-ish data'));
      const compressed = zlib.deflateSync(Buffer.from(original));
      const stream = await buildRawStreamWithFilterArray(compressed, ['FlateDecode']);
      const decoded = decodeStreamBytes(stream);
      expect(Buffer.from(decoded!).toString()).toBe(Buffer.from(original).toString());
    });

    it('still declines (returns null) a genuine multi-filter chain rather than guessing', async () => {
      const stream = await buildRawStreamWithFilterArray(Uint8Array.from([1, 2, 3]), ['ASCII85Decode', 'FlateDecode']);
      expect(decodeStreamBytes(stream)).toBeNull();
    });
  });

  it('declines malformed FlateDecode data rather than throwing', async () => {
    const stream = await buildRawStream(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 'FlateDecode');
    expect(decodeStreamBytes(stream)).toBeNull();
  });

  // CodeRabbit finding on PR #564, confirmed real: a /Predictor > 1 in
  // /DecodeParms is a SEPARATE encoding layer on top of Flate --
  // inflateSync only reverses the zlib compression, not this. Skipping it
  // produces a structurally-valid but pixel-corrupted image (still
  // "succeeds", never throws) that could feed a plausible-looking but
  // WRONG description to Gemini -- worse than declining outright.
  describe('predictor decoding (PDF32000-1:2008 Table 8)', () => {
    it('reverses TIFF Predictor 2 (horizontal differencing)', async () => {
      // 1 colorant, 2 columns, 2 rows. Original: [10,20, 30,40].
      // TIFF-2 encoding: each byte (after the first per row) is the
      // difference from the PREVIOUS byte in the same row.
      const encoded = Uint8Array.from([10, 10, 30, 10]);
      const compressed = zlib.deflateSync(Buffer.from(encoded));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 2, Colors: 1, Columns: 2 });
      const decoded = decodeStreamBytes(stream);
      expect(Array.from(decoded!)).toEqual([10, 20, 30, 40]);
    });

    it('reverses PNG predictors using each row\'s own filter-type tag byte (None then Up)', async () => {
      // Same original pixels as above. Row 0 tagged None (0): stored as-is.
      // Row 1 tagged Up (2): each byte is the difference from the SAME
      // column in the previous (already-decoded) row.
      const encoded = Uint8Array.from([0, 10, 20, /* row 0: None */ 2, 20, 20 /* row 1: Up */]);
      const compressed = zlib.deflateSync(Buffer.from(encoded));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 15, Colors: 1, Columns: 2 });
      const decoded = decodeStreamBytes(stream);
      expect(Array.from(decoded!)).toEqual([10, 20, 30, 40]);
    });

    it('reverses the PNG Paeth predictor', async () => {
      // Row 0 (None): [10, 20]. Row 1 (Paeth, tag 4), original [30, 40]:
      // byte 0 -- a=0, b=10 (up), c=0 -> paeth predicts b=10 (pa=10 loses
      // to pb=0) -> stored = 30-10 = 20.
      // byte 1 -- a=30 (left, already decoded), b=20 (up), c=10
      // (upper-left) -> p=30+20-10=40, pa=|40-30|=10 is the smallest
      // (pa<=pb and pa<=pc) -> paeth predicts a=30 -> stored = 40-30 = 10.
      // (Independently verified via a standalone reference implementation,
      // not hand-arithmetic alone, before trusting this fixture.)
      const encoded = Uint8Array.from([0, 10, 20, /* row 0: None */ 4, 20, 10 /* row 1: Paeth */]);
      const compressed = zlib.deflateSync(Buffer.from(encoded));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 15, Colors: 1, Columns: 2 });
      const decoded = decodeStreamBytes(stream);
      expect(Array.from(decoded!)).toEqual([10, 20, 30, 40]);
    });

    it('treats Predictor 1 (or absent) as a no-op, matching the plain FlateDecode behavior', async () => {
      const original = Uint8Array.from([1, 2, 3, 4]);
      const compressed = zlib.deflateSync(Buffer.from(original));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 1 });
      expect(Array.from(decodeStreamBytes(stream)!)).toEqual([1, 2, 3, 4]);
    });

    it('declines an unrecognized predictor value rather than guessing', async () => {
      const compressed = zlib.deflateSync(Buffer.from([1, 2, 3, 4]));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 99, Colors: 1, Columns: 2 });
      expect(decodeStreamBytes(stream)).toBeNull();
    });

    it('declines predictor-encoded data whose length does not divide evenly into whole rows', async () => {
      // 3 bytes can't form whole (Colors*Columns + 1) = 3-byte PNG rows... use a
      // genuinely mismatched case instead: Colors*Columns=2, so a valid
      // PNG-predictor stride is 3; 4 bytes isn't a multiple of 3.
      const compressed = zlib.deflateSync(Buffer.from([0, 1, 2, 3]));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 15, Colors: 1, Columns: 2 });
      expect(decodeStreamBytes(stream)).toBeNull();
    });

    it('declines an unrecognized per-row PNG filter tag rather than guessing', async () => {
      const encoded = Uint8Array.from([9, 10, 20]); // tag 9 is not a real PNG filter type
      const compressed = zlib.deflateSync(Buffer.from(encoded));
      const stream = await buildRawStream(compressed, 'FlateDecode', { Predictor: 15, Colors: 1, Columns: 2 });
      expect(decodeStreamBytes(stream)).toBeNull();
    });
  });
});

describe('resolveColorSpaceInfo', () => {
  it('resolves the three direct device colorspace names', async () => {
    const doc = await PDFDocument.create();
    expect(resolveColorSpaceInfo(doc.context, PDFName.of('DeviceGray'))).toEqual({ kind: 'gray' });
    expect(resolveColorSpaceInfo(doc.context, PDFName.of('DeviceRGB'))).toEqual({ kind: 'rgb' });
    expect(resolveColorSpaceInfo(doc.context, PDFName.of('DeviceCMYK'))).toEqual({ kind: 'cmyk' });
  });

  it('dereferences an indirect reference before inspecting it (the real bug this whole fix started from)', async () => {
    const doc = await PDFDocument.create();
    const ref = doc.context.register(PDFName.of('DeviceCMYK'));
    // Confirmed live: the old code called .toString() on the PDFRef itself
    // without dereferencing, producing garbage like "2425 0 R" instead of
    // the real colorspace.
    expect(resolveColorSpaceInfo(doc.context, ref)).toEqual({ kind: 'cmyk' });
  });

  it('resolves ICCBased via its /N component count', async () => {
    const doc = await PDFDocument.create();
    const iccStreamDict = doc.context.obj({ N: 4 });
    const iccStreamRef = doc.context.register(PDFRawStream.of(iccStreamDict, new Uint8Array()));
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('ICCBased'));
    csArray.push(iccStreamRef);
    expect(resolveColorSpaceInfo(doc.context, csArray)).toEqual({ kind: 'cmyk' });
  });

  it('declines ICCBased with an unrecognized component count', async () => {
    const doc = await PDFDocument.create();
    const iccStreamDict = doc.context.obj({ N: 2 });
    const iccStreamRef = doc.context.register(PDFRawStream.of(iccStreamDict, new Uint8Array()));
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('ICCBased'));
    csArray.push(iccStreamRef);
    expect(resolveColorSpaceInfo(doc.context, csArray)).toBeNull();
  });

  it('resolves Separation as a single-colorant space', async () => {
    const doc = await PDFDocument.create();
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('Separation'));
    csArray.push(PDFName.of('Black'));
    csArray.push(PDFName.of('DeviceCMYK'));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toEqual({ kind: 'separation' });
  });

  it('resolves a real single-colorant DeviceN (confirmed live: /DeviceN [/Black] /DeviceCMYK ...)', async () => {
    const doc = await PDFDocument.create();
    const names = PDFArray.withContext(doc.context);
    names.push(PDFName.of('Black'));
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('DeviceN'));
    csArray.push(names);
    csArray.push(PDFName.of('DeviceCMYK'));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toEqual({ kind: 'separation' });
  });

  it('declines a multi-colorant DeviceN rather than guessing a tint transform', async () => {
    const doc = await PDFDocument.create();
    const names = PDFArray.withContext(doc.context);
    names.push(PDFName.of('Cyan'));
    names.push(PDFName.of('Magenta'));
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('DeviceN'));
    csArray.push(names);
    csArray.push(PDFName.of('DeviceCMYK'));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toBeNull();
  });

  // CodeRabbit finding on PR #564, confirmed real: convertSamplesToRgb's
  // 'separation' treatment (invert tint into a grayscale intensity) is
  // only correct for a colorant that actually renders as black -- a real
  // spot color (e.g. a Pantone red) has its own alternate-space + tint-
  // transform mapping to a genuinely different color this module doesn't
  // evaluate, and a black-tint assumption would silently paint the wrong
  // color into the image sent to Gemini.
  it('declines a Separation whose colorant is NOT Black rather than assuming it renders as black ink', async () => {
    const doc = await PDFDocument.create();
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('Separation'));
    csArray.push(PDFName.of('PANTONE_186_C'));
    csArray.push(PDFName.of('DeviceCMYK'));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toBeNull();
  });

  it('declines a single-colorant DeviceN whose colorant is NOT Black', async () => {
    const doc = await PDFDocument.create();
    const names = PDFArray.withContext(doc.context);
    names.push(PDFName.of('Orange'));
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('DeviceN'));
    csArray.push(names);
    csArray.push(PDFName.of('DeviceCMYK'));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toBeNull();
  });

  it('resolves Indexed with a string-form lookup table', async () => {
    const doc = await PDFDocument.create();
    const lookupBytes = Buffer.from([255, 0, 0, 0, 0, 0, 0, 255]); // 2 CMYK entries
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('Indexed'));
    csArray.push(PDFName.of('DeviceCMYK'));
    csArray.push(PDFNumber.of(1));
    csArray.push(PDFString.of(lookupBytes.toString('latin1')));

    const result = resolveColorSpaceInfo(doc.context, csArray);
    expect(result?.kind).toBe('indexed');
    if (result?.kind === 'indexed') {
      expect(result.base).toEqual({ kind: 'cmyk' });
      expect(result.lookup.length).toBe(8);
    }
  });

  it('resolves Indexed with a stream-form lookup table (including its own FlateDecode)', async () => {
    const doc = await PDFDocument.create();
    const lookupBytes = Uint8Array.from([0, 128, 255]); // 3 gray-base entries
    const compressed = zlib.deflateSync(Buffer.from(lookupBytes));
    const lookupStreamDict = doc.context.obj({ Filter: PDFName.of('FlateDecode') });
    const lookupStreamRef = doc.context.register(PDFRawStream.of(lookupStreamDict, compressed));

    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('Indexed'));
    csArray.push(PDFName.of('DeviceGray'));
    csArray.push(PDFNumber.of(2));
    csArray.push(lookupStreamRef);

    const result = resolveColorSpaceInfo(doc.context, csArray);
    expect(result?.kind).toBe('indexed');
    if (result?.kind === 'indexed') {
      expect(Array.from(result.lookup)).toEqual([0, 128, 255]);
    }
  });

  it('declines an unresolvable/unsupported colorspace (Lab, CalRGB, Pattern) rather than guessing', async () => {
    const doc = await PDFDocument.create();
    const csArray = PDFArray.withContext(doc.context);
    csArray.push(PDFName.of('Lab'));
    csArray.push(doc.context.obj({}));
    expect(resolveColorSpaceInfo(doc.context, csArray)).toBeNull();
  });

  it('returns null when no /ColorSpace value is present at all', async () => {
    const doc = await PDFDocument.create();
    expect(resolveColorSpaceInfo(doc.context, undefined)).toBeNull();
  });
});
