import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import zlib from 'zlib';
import { PDFName, PDFDict, PDFStream, PDFRawStream, PDFArray, PDFString, PDFHexString, PDFRef, PDFNumber, PDFContext } from 'pdf-lib';
import sharp from 'sharp';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { pdfModifierService } from './pdf-modifier.service';

/**
 * A resolved PDF /ColorSpace, reduced to exactly the shapes confirmed
 * real against live Math_Kim image data (a 1,313-image survey): direct
 * DeviceGray/RGB/CMYK, a single-colorant Separation/DeviceN (a common
 * prepress convention for simulating plain black ink via a spot color --
 * confirmed real: `/DeviceN [/Black] /DeviceCMYK ...`), and Indexed with
 * any of those as its base. ICCBased is accepted only when its /N
 * (component count) unambiguously maps to one of gray/rgb/cmyk -- treating
 * the ICC-managed data as if it were the plain device colorspace of the
 * same channel count is an approximation (no real ICC profile transform is
 * applied), acceptable here because the end use is a visual description
 * for an AI vision model, not color-accurate reproduction.
 *
 * Deliberately does NOT attempt Lab, CalRGB/CalGray, Pattern, or a
 * multi-colorant DeviceN/Separation -- none appeared in the real survey,
 * and each needs real, unverified-here machinery (Lab->RGB conversion, a
 * PDF Function evaluator for a genuine tint transform) to render correctly
 * rather than plausibly. resolveColorSpaceInfo returns null for these,
 * and callers decline (return null) rather than guess.
 */
export type ColorSpaceInfo =
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'cmyk' }
  | { kind: 'separation' }
  | { kind: 'indexed'; base: ColorSpaceInfo; lookup: Uint8Array };

export function channelsFor(info: ColorSpaceInfo): number | null {
  switch (info.kind) {
    case 'gray': return 1;
    case 'rgb': return 3;
    case 'cmyk': return 4;
    case 'separation': return 1;
    case 'indexed': return 1; // one index byte per pixel, regardless of the base's own channel count
    default: return null;
  }
}

export function resolveColorSpaceInfo(context: PDFContext, csObj: unknown): ColorSpaceInfo | null {
  if (csObj === undefined) return null;
  const resolved = context.lookup(csObj as PDFRef);

  if (resolved instanceof PDFArray) {
    const arr = resolved.asArray();
    const kind = arr[0]?.toString();

    if (kind === '/ICCBased') {
      const stream = context.lookup(arr[1]);
      const n = stream instanceof PDFStream ? stream.dict.get(PDFName.of('N')) : undefined;
      const nNum = n instanceof PDFNumber ? n.asNumber() : undefined;
      if (nNum === 1) return { kind: 'gray' };
      if (nNum === 3) return { kind: 'rgb' };
      if (nNum === 4) return { kind: 'cmyk' };
      return null;
    }
    if (kind === '/Indexed') {
      const base = resolveColorSpaceInfo(context, arr[1]);
      const lookupObj = context.lookup(arr[3]);
      let lookup: Uint8Array | null = null;
      if (lookupObj instanceof PDFString || lookupObj instanceof PDFHexString) {
        lookup = Uint8Array.from(lookupObj.asBytes());
      } else if (lookupObj instanceof PDFRawStream || lookupObj instanceof PDFStream) {
        lookup = decodeStreamBytes(lookupObj);
      }
      if (!base || !lookup) return null;
      return { kind: 'indexed', base, lookup };
    }
    if (kind === '/Separation') return { kind: 'separation' };
    if (kind === '/DeviceN') {
      const names = context.lookup(arr[1]);
      const count = names instanceof PDFArray ? names.asArray().length : undefined;
      // Only the single-colorant case is handled -- see this type's own
      // doc comment for why a genuine multi-colorant tint transform isn't
      // attempted.
      return count === 1 ? { kind: 'separation' } : null;
    }
    return null; // CalRGB/CalGray/Lab/Pattern -- not observed in real data
  }

  switch (resolved?.toString()) {
    case '/DeviceGray': return { kind: 'gray' };
    case '/DeviceRGB': return { kind: 'rgb' };
    case '/DeviceCMYK': return { kind: 'cmyk' };
    default: return null;
  }
}

/**
 * Applies the stream's own /Filter, if any, to produce genuinely raw bytes
 * -- PDFRawStream.contents/PDFStream.getContents() deliberately return the
 * stream's stored (still-encoded) bytes, not decoded pixel data. Handles
 * exactly the filters confirmed real in the same survey (none, or plain
 * FlateDecode); declines (returns null) for anything else rather than
 * guessing at an unimplemented decoder (e.g. LZWDecode, a filter array).
 */
export function decodeStreamBytes(xObject: PDFRawStream | PDFStream): Uint8Array | null {
  const raw = xObject instanceof PDFRawStream ? xObject.contents : xObject.getContents();
  const filter = xObject.dict.get(PDFName.of('Filter'));
  if (filter === undefined) return raw;
  const filterName = filter.toString();
  if (filterName === '/FlateDecode') {
    try {
      return zlib.inflateSync(Buffer.from(raw));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Converts genuinely-decoded pixel samples in ANY of resolveColorSpaceInfo's
 * handled shapes into plain 3-channel RGB, so the caller can always hand
 * sharp a uniform `channels: 3` raw buffer regardless of the image's real
 * PDF colorspace -- sidesteps any ambiguity in how a raw-pixel decoder
 * would otherwise need to interpret a 4-channel (CMYK vs RGBA?) or
 * 1-channel buffer itself.
 */
export function convertSamplesToRgb(samples: Uint8Array, info: ColorSpaceInfo, pixelCount: number): Uint8Array | null {
  switch (info.kind) {
    case 'gray': {
      if (samples.length < pixelCount) return null;
      const rgb = new Uint8Array(pixelCount * 3);
      for (let i = 0; i < pixelCount; i++) {
        const g = samples[i];
        rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      }
      return rgb;
    }
    case 'rgb': {
      if (samples.length < pixelCount * 3) return null;
      return samples.slice(0, pixelCount * 3);
    }
    case 'cmyk': {
      if (samples.length < pixelCount * 4) return null;
      const rgb = new Uint8Array(pixelCount * 3);
      for (let i = 0; i < pixelCount; i++) {
        const c = samples[i * 4] / 255, m = samples[i * 4 + 1] / 255, y = samples[i * 4 + 2] / 255, k = samples[i * 4 + 3] / 255;
        rgb[i * 3] = Math.round(255 * (1 - c) * (1 - k));
        rgb[i * 3 + 1] = Math.round(255 * (1 - m) * (1 - k));
        rgb[i * 3 + 2] = Math.round(255 * (1 - y) * (1 - k));
      }
      return rgb;
    }
    case 'separation': {
      // A tint value of 0 means "no ink" (shows the page/background --
      // treated as white); the maximum value means full-strength colorant.
      // Confirmed real case is a /Black separation, so "full ink" ==
      // black is the correct mapping, not an arbitrary guess -- this is
      // the standard prepress convention for simulating plain black text/
      // line art through a spot channel instead of DeviceGray.
      if (samples.length < pixelCount) return null;
      const rgb = new Uint8Array(pixelCount * 3);
      for (let i = 0; i < pixelCount; i++) {
        const gray = 255 - samples[i];
        rgb[i * 3] = gray; rgb[i * 3 + 1] = gray; rgb[i * 3 + 2] = gray;
      }
      return rgb;
    }
    case 'indexed': {
      const baseChannels = channelsFor(info.base);
      if (baseChannels === null || samples.length < pixelCount) return null;
      const baseSamples = new Uint8Array(pixelCount * baseChannels);
      for (let i = 0; i < pixelCount; i++) {
        const off = samples[i] * baseChannels;
        for (let c = 0; c < baseChannels; c++) {
          baseSamples[i * baseChannels + c] = info.lookup[off + c] ?? 0;
        }
      }
      return convertSamplesToRgb(baseSamples, info.base, pixelCount);
    }
    default:
      return null;
  }
}

interface ImagePlacement {
  xObjectName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FigureAltInfo {
  altText?: string;
  isDecorative?: boolean;
}

export interface ImageInfo {
  id: string;
  pageNumber: number;
  index: number;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dimensions: {
    width: number;
    height: number;
  };
  format: 'jpeg' | 'png' | 'jbig2' | 'jpx' | 'unknown';
  colorSpace: string;
  bitsPerComponent: number;
  hasAlpha: boolean;
  fileSizeBytes: number;
  altText?: string;
  isDecorative?: boolean;
  base64?: string;
  mimeType: string;
}

export interface PageImages {
  pageNumber: number;
  images: ImageInfo[];
  totalImages: number;
}

export interface DocumentImages {
  pages: PageImages[];
  totalImages: number;
  imageFormats: Record<string, number>;
  imagesWithAltText: number;
  imagesWithoutAltText: number;
  decorativeImages: number;
}

export interface ExtractionOptions {
  includeBase64?: boolean;
  maxImageSize?: number;
  pageRange?: { start: number; end: number };
  formats?: ('jpeg' | 'png' | 'jbig2' | 'jpx')[];
  minWidth?: number;
  minHeight?: number;
}

class ImageExtractorService {
  private readonly DEFAULT_MAX_SIZE = 1024;
  private readonly MIN_IMAGE_SIZE = 10;

  async extractImages(
    parsedPdf: ParsedPDF,
    options: ExtractionOptions = {}
  ): Promise<DocumentImages> {
    const {
      includeBase64 = false,
      maxImageSize = this.DEFAULT_MAX_SIZE,
      pageRange,
      formats,
      minWidth = this.MIN_IMAGE_SIZE,
      minHeight = this.MIN_IMAGE_SIZE,
    } = options;

    const pages: PageImages[] = [];
    let totalImages = 0;
    const imageFormats: Record<string, number> = {};
    let imagesWithAltText = 0;
    let imagesWithoutAltText = 0;
    let decorativeImages = 0;

    const startPage = pageRange?.start || 1;
    const endPage = pageRange?.end || parsedPdf.structure.pageCount;

    // Computed ONCE for the whole read-only extraction pass and reused by
    // every resolveFigureForImage call below -- see that method's own doc
    // comment on precomputedFigures for why this matters (a real ~18.5s cost
    // on Math_Kim's 1313 real sub-images, confirmed via direct timing, from
    // re-walking the entire struct tree once per image instead of once here).
    const precomputedFigures = pdfModifierService.getAllFigureElements(parsedPdf.pdfLibDoc);

    // Process pages in parallel batches (smaller batch — images are memory-intensive)
    const IMAGE_BATCH_SIZE = 5;
    for (let i = startPage; i <= endPage; i += IMAGE_BATCH_SIZE) {
      const batchEnd = Math.min(i + IMAGE_BATCH_SIZE - 1, endPage);
      const batchNums = Array.from({ length: batchEnd - i + 1 }, (_, k) => i + k);
      const batchPages = await Promise.all(
        batchNums.map((pageNum) =>
          this.extractPageImages(parsedPdf, pageNum, {
            includeBase64,
            maxImageSize,
            formats,
            minWidth,
            minHeight,
            precomputedFigures,
          })
        )
      );

      for (const pageImages of batchPages) {
        pages.push(pageImages);
        totalImages += pageImages.totalImages;

        for (const img of pageImages.images) {
          imageFormats[img.format] = (imageFormats[img.format] || 0) + 1;

          if (img.isDecorative || img.altText === '') {
            // An explicit empty /Alt is the PDF/UA-compliant decorative marker,
            // distinct from no /Alt entry at all (img.altText === undefined).
            decorativeImages++;
          } else if (img.altText) {
            imagesWithAltText++;
          } else {
            imagesWithoutAltText++;
          }
        }
      }
    }

    return {
      pages,
      totalImages,
      imageFormats,
      imagesWithAltText,
      imagesWithoutAltText,
      decorativeImages,
    };
  }

  private async extractPageImages(
    parsedPdf: ParsedPDF,
    pageNumber: number,
    options: {
      includeBase64: boolean;
      maxImageSize: number;
      formats?: ('jpeg' | 'png' | 'jbig2' | 'jpx')[];
      minWidth: number;
      minHeight: number;
      precomputedFigures?: PDFDict[];
    }
  ): Promise<PageImages> {
    const images: ImageInfo[] = [];
    
    try {
      const page = await parsedPdf.pdfjsDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const operatorList = await page.getOperatorList();
      
      const imagePlacements = this.extractImagePlacements(operatorList, viewport);

      const pdfLibPage = parsedPdf.pdfLibDoc.getPages()[pageNumber - 1];
      const resources = pdfLibPage?.node?.get(PDFName.of('Resources'));

      if (resources instanceof PDFDict) {
        const xObjects = resources.get(PDFName.of('XObject'));

        if (xObjects instanceof PDFDict) {
          const entries = xObjects.entries();
          let index = 0;

          for (const [name, ref] of entries) {
            try {
              const xObject = parsedPdf.pdfLibDoc.context.lookup(ref);

              if (xObject instanceof PDFRawStream || xObject instanceof PDFStream) {
                const subtype = xObject.dict.get(PDFName.of('Subtype'));

                if (subtype?.toString() === '/Image') {
                  // Early size filter using dict metadata — avoids decompressing tiny images
                  const dictWidth = parseInt(xObject.dict.get(PDFName.of('Width'))?.toString() || '0', 10);
                  const dictHeight = parseInt(xObject.dict.get(PDFName.of('Height'))?.toString() || '0', 10);
                  if (dictWidth < options.minWidth || dictHeight < options.minHeight) {
                    index++;
                    continue;
                  }

                  const xObjectName = name.toString().replace('/', '');

                  const placement = imagePlacements.find(p => p.xObjectName === xObjectName)
                    || imagePlacements[index]
                    || { xObjectName, x: 0, y: 0, width: 100, height: 100 };

                  // Resolve the SAME Figure setAltText itself would resolve for this
                  // exact image id (MCID-exact match, page-scoped positional fallback)
                  // -- see resolveFigureForImage's own doc comment for why this must be
                  // the single shared resolution used by both detection and writing.
                  const imageId = `img_p${pageNumber}_${index}_${xObjectName}`;
                  const figureDict = pdfModifierService.resolveFigureForImage(
                    parsedPdf.pdfLibDoc,
                    imageId,
                    options.precomputedFigures
                  );
                  const structInfo: FigureAltInfo | undefined = figureDict
                    ? this.extractFigureInfo(figureDict)
                    : undefined;

                  const imageInfo = await this.processImage(
                    xObject,
                    xObjectName,
                    pageNumber,
                    index,
                    { x: placement.x, y: placement.y, width: placement.width, height: placement.height },
                    viewport,
                    options,
                    structInfo?.altText,
                    structInfo?.isDecorative
                  );

                  if (imageInfo &&
                      imageInfo.dimensions.width >= options.minWidth &&
                      imageInfo.dimensions.height >= options.minHeight) {
                    
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- format comparison requires any cast
                    if (!options.formats || options.formats.includes(imageInfo.format as any)) {
                      images.push(imageInfo);
                    }
                  }
                  
                  index++;
                }
              }
            } catch (err) {
              console.warn(`Failed to process image on page ${pageNumber}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to extract images from page ${pageNumber}:`, err);
    }

    return {
      pageNumber,
      images,
      totalImages: images.length,
    };
  }

  private extractImagePlacements(
    operatorList: Record<string, unknown>,
    viewport: pdfjsLib.PageViewport
  ): ImagePlacement[] {
    const placements: ImagePlacement[] = [];
    const OPS = pdfjsLib.OPS;
    
    const transformStack: number[][] = [];
    let currentTransform = [1, 0, 0, 1, 0, 0];

    const fnArray = operatorList.fnArray as unknown[];
    const argsArray = operatorList.argsArray as unknown[][];

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      
      if (fn === OPS.save) {
        transformStack.push([...currentTransform]);
      } else if (fn === OPS.restore) {
        if (transformStack.length > 0) {
          currentTransform = transformStack.pop()!;
        }
      } else if (fn === OPS.transform) {
        currentTransform = this.multiplyTransforms(currentTransform, args as number[]);
      } else if (fn === OPS.paintImageXObject) {
        const xObjectName = args[0] as string;
        const [a, b, c, d, e, f] = currentTransform;
        
        const scaleX = Math.sqrt(a * a + b * b);
        const scaleY = Math.sqrt(c * c + d * d);
        const width = scaleX;
        const height = scaleY;
        const x = e;
        const y = viewport.height - f - height;
        
        placements.push({ xObjectName, x, y, width, height });
      } else if (fn === OPS.paintImageXObjectRepeat) {
        const xObjectName = args[0] as string;
        const scaleX = args[1] as number;
        const scaleY = args[2] as number;
        const positions = args[3] as number[];
        
        for (let j = 0; j < positions.length; j += 2) {
          const tx = positions[j];
          const ty = positions[j + 1];
          
          const instanceTransform = this.multiplyTransforms(
            currentTransform,
            [scaleX, 0, 0, scaleY, tx, ty]
          );
          
          const [a, , , d, ie, ifa] = instanceTransform;
          const width = Math.abs(a);
          const height = Math.abs(d);
          const x = ie;
          const y = viewport.height - ifa - height;
          
          placements.push({ xObjectName, x, y, width, height });
        }
      }
    }
    
    return placements;
  }

  /**
   * Pull alt-text/decorative info out of an ALREADY-RESOLVED Figure struct
   * element (see resolveFigureForImage's own doc comment for how the
   * correct Figure is found per image -- this method's only job is reading
   * its /Alt, /ActualText and /A /Placement entries, not locating it).
   */
  private extractFigureInfo(node: PDFDict): FigureAltInfo {
    const info: FigureAltInfo = {};

    const alt = node.get(PDFName.of('Alt'));
    if (alt instanceof PDFString) {
      info.altText = alt.decodeText();
    } else if (alt instanceof PDFHexString) {
      info.altText = alt.decodeText();
    }

    const actualText = node.get(PDFName.of('ActualText'));
    // Only fall back to ActualText when /Alt is absent entirely. An explicit
    // empty /Alt ("") is a deliberate decorative marker and must be preserved,
    // not silently overwritten by a (possibly stale) non-empty /ActualText.
    if (info.altText === undefined) {
      if (actualText instanceof PDFString) {
        info.altText = actualText.decodeText();
      } else if (actualText instanceof PDFHexString) {
        info.altText = actualText.decodeText();
      }
    }

    const aRef = node.get(PDFName.of('A'));
    if (aRef) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf-lib context.lookup requires PDFRef cast
      const a = node.context.lookup(aRef as any);
      if (a instanceof PDFDict) {
        const placement = a.get(PDFName.of('Placement'));
        if (placement?.toString() === '/Artifact') {
          info.isDecorative = true;
        }
      } else if (a instanceof PDFArray) {
        for (let i = 0; i < a.size(); i++) {
          const attrRef = a.get(i);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf-lib context.lookup requires PDFRef cast
          const attr = node.context.lookup(attrRef as any);
          if (attr instanceof PDFDict) {
            const placement = attr.get(PDFName.of('Placement'));
            if (placement?.toString() === '/Artifact') {
              info.isDecorative = true;
              break;
            }
          }
        }
      }
    }

    return info;
  }

  private multiplyTransforms(t1: number[], t2: number[]): number[] {
    return [
      t1[0] * t2[0] + t1[2] * t2[1],
      t1[1] * t2[0] + t1[3] * t2[1],
      t1[0] * t2[2] + t1[2] * t2[3],
      t1[1] * t2[2] + t1[3] * t2[3],
      t1[0] * t2[4] + t1[2] * t2[5] + t1[4],
      t1[1] * t2[4] + t1[3] * t2[5] + t1[5],
    ];
  }

  private async processImage(
    xObject: PDFRawStream | PDFStream,
    name: string,
    pageNumber: number,
    index: number,
    position: { x: number; y: number; width: number; height: number },
    viewport: pdfjsLib.PageViewport,
    options: { includeBase64: boolean; maxImageSize: number },
    altText?: string,
    isDecorative?: boolean
  ): Promise<ImageInfo | null> {
    try {
      const dict = xObject.dict;
      
      const width = dict.get(PDFName.of('Width'))?.toString() || '0';
      const height = dict.get(PDFName.of('Height'))?.toString() || '0';
      const bitsPerComponent = dict.get(PDFName.of('BitsPerComponent'))?.toString() || '8';
      const colorSpace = dict.get(PDFName.of('ColorSpace'))?.toString() || '/DeviceRGB';
      const filter = dict.get(PDFName.of('Filter'))?.toString() || '';

      let format: ImageInfo['format'] = 'unknown';
      let mimeType = 'image/unknown';
      // Whether this image's raw samples are ones convertSamplesToRgb can
      // handle -- confirmed real cases only (see that function's own doc
      // comment): no filter at all (samples are already raw), or plain
      // FlateDecode (needs one zlib.inflateSync). LZWDecode was previously
      // lumped in here as "png" alongside FlateDecode, but decodeStreamBytes
      // has no LZW decoder -- treating it as rawSamplesFormat would always
      // fail decodeStreamBytes and correctly decline, so no separate branch
      // is needed for it here.
      const isRawSamplesFilter = filter === '' || filter === '/FlateDecode';

      if (filter.includes('DCTDecode')) {
        format = 'jpeg';
        mimeType = 'image/jpeg';
      } else if (isRawSamplesFilter) {
        format = 'png';
        mimeType = 'image/png';
      } else if (filter.includes('JBIG2Decode')) {
        format = 'jbig2';
        mimeType = 'image/jbig2';
      } else if (filter.includes('JPXDecode')) {
        format = 'jpx';
        mimeType = 'image/jp2';
      }

      // Only decompress image data when base64 output is needed.
      // For metadata-only audits, read the compressed length from the dict to avoid
      // decompressing potentially thousands of image streams (e.g. equation images).
      let imageData: Uint8Array | null = null;
      let fileSizeBytes = 0;

      if (options.includeBase64) {
        if (xObject instanceof PDFRawStream) {
          imageData = xObject.contents;
        } else {
          imageData = xObject.getContents();
        }
        fileSizeBytes = imageData.length;
      } else {
        // Use the compressed stream length from the dict (no decompression required)
        const lengthObj = dict.get(PDFName.of('Length'));
        fileSizeBytes = lengthObj ? parseInt(lengthObj.toString(), 10) || 0 : 0;
      }

      const sMask = dict.get(PDFName.of('SMask'));
      const hasAlpha = sMask !== undefined;

      const imageInfo: ImageInfo = {
        id: `img_p${pageNumber}_${index}_${name}`,
        pageNumber,
        index,
        position: {
          x: Math.round(position.x),
          y: Math.round(position.y),
          width: Math.round(position.width),
          height: Math.round(position.height),
        },
        dimensions: {
          width: parseInt(width, 10),
          height: parseInt(height, 10),
        },
        format,
        colorSpace: colorSpace.replace('/', ''),
        bitsPerComponent: parseInt(bitsPerComponent, 10),
        hasAlpha,
        fileSizeBytes,
        mimeType,
        altText,
        isDecorative,
      };

      if (options.includeBase64 && imageData && (format === 'jpeg' || format === 'png')) {
        try {
          // Real /ColorSpace + genuinely-decoded (not still-Filter-encoded)
          // samples, only for the raw-samples case -- JPEG bytes are
          // self-contained and decoded by sharp/the JPEG-SOI branch below
          // regardless of the PDF's own stated colorspace metadata.
          const colorSpaceInfo = format === 'png'
            ? resolveColorSpaceInfo(dict.context, dict.get(PDFName.of('ColorSpace')))
            : null;
          const decodedSamples = format === 'png' ? decodeStreamBytes(xObject) : null;

          const base64 = await this.convertToBase64(
            imageData as Uint8Array,
            format,
            imageInfo.dimensions.width,
            imageInfo.dimensions.height,
            options.maxImageSize,
            imageInfo.bitsPerComponent,
            colorSpaceInfo,
            decodedSamples
          );

          if (base64) {
            imageInfo.base64 = base64;
          }
        } catch (err) {
          console.warn(`Failed to convert image to base64:`, err);
        }
      }

      return imageInfo;
    } catch (err) {
      console.warn(`Failed to process image:`, err);
      return null;
    }
  }

  private async convertToBase64(
    data: Uint8Array,
    format: 'jpeg' | 'png',
    width: number,
    height: number,
    maxSize: number,
    bitsPerComponent?: number,
    colorSpaceInfo?: ColorSpaceInfo | null,
    decodedSamples?: Uint8Array | null
  ): Promise<string | null> {
    try {
      if (format === 'jpeg') {
        if (data[0] === 0xFF && data[1] === 0xD8) {
          if (width > maxSize || height > maxSize) {
            const resized = await sharp(Buffer.from(data))
              .resize(maxSize, maxSize, { fit: 'inside' })
              .jpeg({ quality: 85 })
              .toBuffer();
            return resized.toString('base64');
          }
          return Buffer.from(data).toString('base64');
        }
        return null;
      }

      // Real /ColorSpace resolution + genuine stream decompression --
      // confirmed live against Math_Kim (1,313-image survey) that the old
      // code here always assumed 3-channel RGB raw samples regardless of
      // the image's real colorspace, AND fed still-Filter-encoded bytes
      // (never decompressed) straight into sharp's raw-pixel decoder --
      // silently failing (sharp throws on the size mismatch, caught below)
      // for the 88% of real images that are actually DeviceCMYK (4ch),
      // Indexed, or a single-colorant Separation/DeviceN (1ch), or that
      // use FlateDecode (raw bytes still zlib-compressed). Declines (null)
      // rather than guessing when colorspace/decompression/bit-depth isn't
      // one of the confirmed-real, handled shapes -- see
      // resolveColorSpaceInfo's and decodeStreamBytes's own doc comments.
      if (bitsPerComponent !== 8 || !colorSpaceInfo || !decodedSamples) return null;
      const rgbSamples = convertSamplesToRgb(decodedSamples, colorSpaceInfo, width * height);
      if (!rgbSamples) return null;

      try {
        const converted = await sharp(Buffer.from(rgbSamples), {
          raw: { width, height, channels: 3 },
        })
          .resize(maxSize, maxSize, { fit: 'inside' })
          .png()
          .toBuffer();

        return converted.toString('base64');
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  async extractFromFile(
    filePath: string,
    options: ExtractionOptions = {}
  ): Promise<DocumentImages> {
    const parsedPdf = await pdfParserService.parse(filePath);
    try {
      return await this.extractImages(parsedPdf, options);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  async extractFromPages(
    parsedPdf: ParsedPDF,
    pageNumbers: number[],
    options: ExtractionOptions = {}
  ): Promise<PageImages[]> {
    const pages: PageImages[] = [];
    
    for (const pageNum of pageNumbers) {
      const pageImages = await this.extractPageImages(parsedPdf, pageNum, {
        includeBase64: options.includeBase64 ?? false,
        maxImageSize: options.maxImageSize ?? this.DEFAULT_MAX_SIZE,
        formats: options.formats,
        minWidth: options.minWidth ?? this.MIN_IMAGE_SIZE,
        minHeight: options.minHeight ?? this.MIN_IMAGE_SIZE,
      });
      pages.push(pageImages);
    }
    
    return pages;
  }

  async getImageById(
    parsedPdf: ParsedPDF,
    imageId: string,
    includeBase64 = true
  ): Promise<ImageInfo | null> {
    const match = imageId.match(/^img_p(\d+)_(\d+)_(.+)$/);
    if (!match) return null;
    
    const pageNumber = parseInt(match[1], 10);
    
    const pageImages = await this.extractPageImages(parsedPdf, pageNumber, {
      includeBase64,
      maxImageSize: this.DEFAULT_MAX_SIZE,
      minWidth: 1,
      minHeight: 1,
    });
    
    return pageImages.images.find(img => img.id === imageId) || null;
  }

  async getImageStats(parsedPdf: ParsedPDF): Promise<{
    totalImages: number;
    pagesWithImages: number;
    pagesWithoutImages: number;
    averageImagesPerPage: number;
    formatDistribution: Record<string, number>;
  }> {
    const images = await this.extractImages(parsedPdf, { includeBase64: false });
    
    const pagesWithImages = images.pages.filter(p => p.totalImages > 0).length;
    
    return {
      totalImages: images.totalImages,
      pagesWithImages,
      pagesWithoutImages: images.pages.length - pagesWithImages,
      averageImagesPerPage: images.totalImages / images.pages.length,
      formatDistribution: images.imageFormats,
    };
  }
}

export const imageExtractorService = new ImageExtractorService();
