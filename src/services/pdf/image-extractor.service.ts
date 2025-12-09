import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFName, PDFDict, PDFStream, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';

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
      
      const imagePositions = this.extractImagePositions(operatorList, viewport);
      
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
                  const imageInfo = await this.processImage(
                    xObject,
                    name.toString().replace('/', ''),
                    pageNumber,
                    index,
                    imagePositions[index] || { x: 0, y: 0, width: 100, height: 100 },
                    viewport,
                    options
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

  private extractImagePositions(
    operatorList: any,
    viewport: pdfjsLib.PageViewport
  ): Array<{ x: number; y: number; width: number; height: number }> {
    const positions: Array<{ x: number; y: number; width: number; height: number }> = [];
    const OPS = pdfjsLib.OPS;
    
    let currentTransform = [1, 0, 0, 1, 0, 0];
    
    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const fn = operatorList.fnArray[i];
      const args = operatorList.argsArray[i];
      
      if (fn === OPS.transform) {
        currentTransform = this.multiplyTransforms(currentTransform, args);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const [a, b, c, d, e, f] = currentTransform;
        const width = Math.abs(a);
        const height = Math.abs(d);
        const x = e;
        const y = viewport.height - f - height;
        
        positions.push({ x, y, width, height });
      }
    }
    
    return positions;
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
    options: { includeBase64: boolean; maxImageSize: number }
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
    } catch (err) {
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
    const index = parseInt(match[2], 10);
    
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
