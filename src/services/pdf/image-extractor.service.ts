import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFName, PDFDict, PDFStream, PDFRawStream, PDFArray, PDFString, PDFHexString } from 'pdf-lib';
import sharp from 'sharp';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { pdfModifierService } from './pdf-modifier.service';

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
      
      if (filter.includes('DCTDecode')) {
        format = 'jpeg';
        mimeType = 'image/jpeg';
      } else if (filter.includes('FlateDecode') || filter.includes('LZWDecode')) {
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
          const base64 = await this.convertToBase64(
            imageData as Uint8Array,
            format,
            imageInfo.dimensions.width,
            imageInfo.dimensions.height,
            options.maxImageSize
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
    maxSize: number
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
      }
      
      try {
        const converted = await sharp(Buffer.from(data), {
          raw: format !== 'jpeg' ? {
            width,
            height,
            channels: 3,
          } : undefined,
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
