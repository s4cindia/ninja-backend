import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFName, PDFDict, PDFStream, PDFRawStream, PDFArray, PDFString, PDFHexString, PDFRef, PDFNumber, PDFObject } from 'pdf-lib';
import sharp from 'sharp';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';

interface ImagePlacement {
  xObjectName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StructureTreeImageInfo {
  xObjectName?: string;
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

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const pageImages = await this.extractPageImages(
        parsedPdf,
        pageNum,
        {
          includeBase64,
          maxImageSize,
          formats,
          minWidth,
          minHeight,
        }
      );

      pages.push(pageImages);
      totalImages += pageImages.totalImages;

      for (const img of pageImages.images) {
        imageFormats[img.format] = (imageFormats[img.format] || 0) + 1;
        
        if (img.isDecorative) {
          decorativeImages++;
        } else if (img.altText) {
          imagesWithAltText++;
        } else {
          imagesWithoutAltText++;
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
    }
  ): Promise<PageImages> {
    const images: ImageInfo[] = [];
    
    try {
      const page = await parsedPdf.pdfjsDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const operatorList = await page.getOperatorList();
      
      const imagePlacements = this.extractImagePlacements(operatorList, viewport);
      
      const structureTreeInfo = this.extractStructureTreeInfo(parsedPdf, pageNumber);
      
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
                  const xObjectName = name.toString().replace('/', '');
                  
                  const placement = imagePlacements.find(p => p.xObjectName === xObjectName)
                    || imagePlacements[index]
                    || { xObjectName, x: 0, y: 0, width: 100, height: 100 };
                  
                  const structInfo = structureTreeInfo.find(s => s.xObjectName === xObjectName);
                  
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

  private extractStructureTreeInfo(
    parsedPdf: ParsedPDF,
    pageNumber: number
  ): StructureTreeImageInfo[] {
    const imageInfos: StructureTreeImageInfo[] = [];
    
    try {
      const catalog = parsedPdf.pdfLibDoc.context.lookup(
        parsedPdf.pdfLibDoc.context.trailerInfo.Root
      );
      
      if (!(catalog instanceof PDFDict)) return imageInfos;
      
      const structTreeRootRef = catalog.get(PDFName.of('StructTreeRoot'));
      if (!structTreeRootRef) return imageInfos;
      
      const structTreeRoot = parsedPdf.pdfLibDoc.context.lookup(structTreeRootRef);
      if (!(structTreeRoot instanceof PDFDict)) return imageInfos;
      
      const pageRef = this.getPageRef(parsedPdf, pageNumber);
      
      this.traverseStructureTree(structTreeRoot, parsedPdf, pageRef, imageInfos);
    } catch (err) {
      console.warn('Failed to extract structure tree info:', err);
    }
    
    return imageInfos;
  }

  private getPageRef(parsedPdf: ParsedPDF, pageNumber: number): PDFRef | null {
    try {
      const pages = parsedPdf.pdfLibDoc.getPages();
      if (pageNumber >= 1 && pageNumber <= pages.length) {
        const page = pages[pageNumber - 1];
        return page.ref;
      }
    } catch {
    }
    return null;
  }

  private traverseStructureTree(
    node: PDFDict,
    parsedPdf: ParsedPDF,
    targetPageRef: PDFRef | null,
    results: StructureTreeImageInfo[]
  ): void {
    try {
      const sType = node.get(PDFName.of('S'));
      const sTypeStr = sType?.toString() || '';
      
      if (sTypeStr === '/Figure' || sTypeStr === '/Image') {
        const info = this.extractFigureInfo(node, parsedPdf, targetPageRef);
        if (info && (info.altText !== undefined || info.isDecorative !== undefined || info.xObjectName)) {
          results.push(info);
        }
      }
      
      const kids = node.get(PDFName.of('K'));
      this.processKids(kids, parsedPdf, targetPageRef, results);
    } catch {
    }
  }

  private extractFigureInfo(
    node: PDFDict,
    parsedPdf: ParsedPDF,
    targetPageRef: PDFRef | null
  ): StructureTreeImageInfo | null {
    const info: StructureTreeImageInfo = {};
    
    const alt = node.get(PDFName.of('Alt'));
    if (alt instanceof PDFString) {
      info.altText = alt.decodeText();
    } else if (alt instanceof PDFHexString) {
      info.altText = alt.decodeText();
    }
    
    const actualText = node.get(PDFName.of('ActualText'));
    if (!info.altText) {
      if (actualText instanceof PDFString) {
        info.altText = actualText.decodeText();
      } else if (actualText instanceof PDFHexString) {
        info.altText = actualText.decodeText();
      }
    }
    
    const aRef = node.get(PDFName.of('A'));
    if (aRef) {
      const a = parsedPdf.pdfLibDoc.context.lookup(aRef);
      if (a instanceof PDFDict) {
        const placement = a.get(PDFName.of('Placement'));
        if (placement?.toString() === '/Artifact') {
          info.isDecorative = true;
        }
      } else if (a instanceof PDFArray) {
        for (let i = 0; i < a.size(); i++) {
          const attrRef = a.get(i);
          const attr = parsedPdf.pdfLibDoc.context.lookup(attrRef);
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
    
    const k = node.get(PDFName.of('K'));
    const xObjectName = this.resolveXObjectFromK(k, parsedPdf, targetPageRef);
    if (xObjectName) {
      info.xObjectName = xObjectName;
    }
    
    return info;
  }

  private resolveXObjectFromK(
    k: PDFObject | undefined,
    parsedPdf: ParsedPDF,
    targetPageRef: PDFRef | null
  ): string | undefined {
    if (!k) return undefined;

    const resolved = parsedPdf.pdfLibDoc.context.lookup(k as any);

    if (resolved instanceof PDFDict) {
      const type = resolved.get(PDFName.of('Type'));
      if (type?.toString() === '/OBJR') {
        const pg = resolved.get(PDFName.of('Pg'));
        if (targetPageRef && pg) {
          const pgResolved = parsedPdf.pdfLibDoc.context.lookup(pg as any);
          if (pgResolved !== parsedPdf.pdfLibDoc.context.lookup(targetPageRef as any)) {
            return undefined;
          }
        }

        const obj = resolved.get(PDFName.of('Obj'));
        if (obj && obj instanceof PDFRef) {
          const xObjectName = this.findXObjectNameByRef(parsedPdf, targetPageRef, obj);
          if (xObjectName) {
            return xObjectName;
          }
        }
      }

      const name = resolved.get(PDFName.of('Name'));
      if (name) {
        return name.toString().replace('/', '');
      }
    } else if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const item = resolved.get(i);
        const xObjectName = this.resolveXObjectFromK(item, parsedPdf, targetPageRef);
        if (xObjectName) return xObjectName;
      }
    } else if (resolved instanceof PDFNumber) {
      return undefined;
    }
    
    return undefined;
  }

  private findXObjectNameByRef(
    parsedPdf: ParsedPDF,
    targetPageRef: PDFRef | null,
    objRef: PDFRef
  ): string | undefined {
    try {
      if (!targetPageRef) return undefined;
      
      const pages = parsedPdf.pdfLibDoc.getPages();
      let targetPage = null;
      
      for (const page of pages) {
        if (page.ref === targetPageRef) {
          targetPage = page;
          break;
        }
      }
      
      if (!targetPage) return undefined;
      
      const resourcesRef = targetPage.node.get(PDFName.of('Resources'));
      if (!resourcesRef) return undefined;
      
      const resources = parsedPdf.pdfLibDoc.context.lookup(resourcesRef);
      if (!(resources instanceof PDFDict)) return undefined;
      
      const xObjectsRef = resources.get(PDFName.of('XObject'));
      if (!xObjectsRef) return undefined;
      
      const xObjects = parsedPdf.pdfLibDoc.context.lookup(xObjectsRef);
      if (!(xObjects instanceof PDFDict)) return undefined;
      
      for (const [name, ref] of xObjects.entries()) {
        if (ref instanceof PDFRef && 
            ref.objectNumber === objRef.objectNumber && 
            ref.generationNumber === objRef.generationNumber) {
          return name.toString().replace('/', '');
        }
      }
    } catch {
    }
    
    return undefined;
  }

  private processKids(
    kids: PDFObject | undefined,
    parsedPdf: ParsedPDF,
    targetPageRef: PDFRef | null,
    results: StructureTreeImageInfo[]
  ): void {
    if (!kids) return;

    const resolved = parsedPdf.pdfLibDoc.context.lookup(kids as any);

    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const kid = resolved.get(i);
        const kidResolved = parsedPdf.pdfLibDoc.context.lookup(kid as any);
        if (kidResolved instanceof PDFDict) {
          this.traverseStructureTree(kidResolved, parsedPdf, targetPageRef, results);
        }
      }
    } else if (resolved instanceof PDFDict) {
      const type = resolved.get(PDFName.of('Type'));
      if (type?.toString() !== '/OBJR' && type?.toString() !== '/MCR') {
        this.traverseStructureTree(resolved, parsedPdf, targetPageRef, results);
      }
    }
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
      
      let imageData: Uint8Array;
      if (xObject instanceof PDFRawStream) {
        imageData = xObject.contents;
      } else {
        imageData = xObject.getContents();
      }
      
      const fileSizeBytes = imageData.length;
      
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
      
      if (options.includeBase64 && (format === 'jpeg' || format === 'png')) {
        try {
          const base64 = await this.convertToBase64(
            imageData,
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
