/**
 * Comprehensive PDF Parser Service
 *
 * Integrates pdf-lib and pdfjs-dist to extract complete PDF structure,
 * metadata, and content for accessibility auditing.
 *
 * Implements US-PDF-1.1 requirements
 */

import { logger } from '../../lib/logger';
import { pdfParserService, ParsedPDF, PDFMetadata as BasePDFMetadata } from './pdf-parser.service';
import { textExtractorService, PageText } from './text-extractor.service';
import { imageExtractorService, ImageInfo } from './image-extractor.service';
import { structureAnalyzerService, HeadingInfo, TableInfo, ListInfo, LinkInfo } from './structure-analyzer.service';
import { PDFDict, PDFName, PDFArray, PDFString } from 'pdf-lib';
import { AppError } from '../../utils/app-error';
import fs from 'fs/promises';

/**
 * Extended PDF metadata with all required fields
 */
export interface PdfMetadata extends BasePDFMetadata {
  pageCount: number;
  hasStructureTree: boolean;
}

/**
 * Structure tree node representing PDF tag structure
 */
export interface PdfStructureNode {
  type: string;
  id?: string;
  title?: string;
  alt?: string;
  actualText?: string;
  lang?: string;
  pageNumber?: number;
  children?: PdfStructureNode[];
}

/**
 * Text content with position information
 */
export interface PdfTextContent {
  text: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  font?: {
    name: string;
    size: number;
  };
}

/**
 * Image with metadata
 */
export interface PdfImage {
  id: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  altText?: string;
  actualText?: string;
  hasAltText: boolean;
}

/**
 * Link with destination
 */
export interface PdfLink {
  text: string;
  url?: string;
  destination?: number; // Page number
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  hasDescriptiveText: boolean;
}

/**
 * Form field information
 */
export interface PdfFormField {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'select' | 'button';
  label?: string;
  value?: string;
  required: boolean;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Single PDF page with all content
 */
export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  content: PdfTextContent[];
  images: PdfImage[];
  links: PdfLink[];
  formFields: PdfFormField[];
  headings: HeadingInfo[];
  tables: TableInfo[];
  lists: ListInfo[];
}

/**
 * Complete PDF parse result
 */
export interface PdfParseResult {
  metadata: PdfMetadata;
  pages: PdfPage[];
  structureTree?: PdfStructureNode[];
  isTagged: boolean;
}

/**
 * Comprehensive PDF Parser Service
 */
class PdfComprehensiveParserService {
  /**
   * Parse PDF file and extract all structure, metadata, and content
   *
   * @param filePath - Path to PDF file
   * @returns Complete parse result with metadata, pages, and structure
   */
  async parse(filePath: string): Promise<PdfParseResult> {
    let parsedPdf: ParsedPDF | null = null;

    try {
      logger.info(`[PdfComprehensiveParser] Parsing PDF: ${filePath}`);

      // Validate file exists
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats) {
        throw AppError.notFound('PDF file not found');
      }

      // Parse with base parser
      parsedPdf = await pdfParserService.parse(filePath);

      // Extract comprehensive content
      const result = await this.extractComprehensiveContent(parsedPdf);

      logger.info(`[PdfComprehensiveParser] Parse complete: ${result.pages.length} pages, tagged=${result.isTagged}`);

      return result;
    } catch (error) {
      logger.error(`[PdfComprehensiveParser] Parse failed:`, error);
      throw error;
    } finally {
      // Always cleanup PDF handle, even if extraction fails
      if (parsedPdf) {
        try {
          await pdfParserService.close(parsedPdf);
        } catch (closeError) {
          logger.warn('[PdfComprehensiveParser] Failed to close PDF handle:', closeError);
        }
      }
    }
  }

  /**
   * Parse PDF from buffer
   *
   * @param buffer - PDF file buffer
   * @param fileName - Original filename
   * @returns Complete parse result
   */
  async parseBuffer(buffer: Buffer, fileName = 'document.pdf'): Promise<PdfParseResult> {
    let parsedPdf: ParsedPDF | null = null;

    try {
      logger.info(`[PdfComprehensiveParser] Parsing PDF buffer: ${fileName}`);

      // Parse with base parser
      parsedPdf = await pdfParserService.parseBuffer(buffer, fileName);

      // Extract comprehensive content
      const result = await this.extractComprehensiveContent(parsedPdf);

      logger.info(`[PdfComprehensiveParser] Parse complete: ${result.pages.length} pages, tagged=${result.isTagged}`);

      return result;
    } catch (error) {
      logger.error(`[PdfComprehensiveParser] Parse buffer failed:`, error);
      throw error;
    } finally {
      // Always cleanup PDF handle, even if extraction fails
      if (parsedPdf) {
        try {
          await pdfParserService.close(parsedPdf);
        } catch (closeError) {
          logger.warn('[PdfComprehensiveParser] Failed to close PDF handle:', closeError);
        }
      }
    }
  }

  /**
   * Extract comprehensive content from parsed PDF
   *
   * @param parsedPdf - Base parsed PDF
   * @returns Complete parse result
   */
  private async extractComprehensiveContent(parsedPdf: ParsedPDF): Promise<PdfParseResult> {
    const { structure, pdfLibDoc } = parsedPdf;

    // Extract metadata
    const metadata: PdfMetadata = {
      ...structure.metadata,
      pageCount: structure.pageCount,
      hasStructureTree: structure.metadata.isTagged,
    };

    // Extract structure tree if tagged
    let structureTree: PdfStructureNode[] | undefined;
    if (metadata.isTagged) {
      try {
        structureTree = this.extractStructureTree(pdfLibDoc);
      } catch (error) {
        logger.warn(`[PdfComprehensiveParser] Failed to extract structure tree:`, error);
        structureTree = undefined;
      }
    }

    // Extract text content for all pages
    logger.info(`[PdfComprehensiveParser] Extracting text content...`);
    const documentText = await textExtractorService.extractText(parsedPdf);

    // Extract images for all pages
    logger.info(`[PdfComprehensiveParser] Extracting images...`);
    const documentImages = await imageExtractorService.extractImages(parsedPdf);

    // Extract structure elements
    logger.info(`[PdfComprehensiveParser] Analyzing structure...`);
    const documentStructure = await structureAnalyzerService.analyzeStructure(parsedPdf);

    // Build pages
    const pages: PdfPage[] = [];
    for (let pageNum = 1; pageNum <= structure.pageCount; pageNum++) {
      const pageInfo = structure.pages[pageNum - 1];
      const pageText = documentText.pages.find(p => p.pageNumber === pageNum);
      const pageImageInfo = documentImages.pages.find(p => p.pageNumber === pageNum);
      const pageImages = pageImageInfo ? pageImageInfo.images : [];
      const pageHeadings = documentStructure.headings.headings.filter((h: HeadingInfo) => h.pageNumber === pageNum);
      const pageTables = documentStructure.tables.filter((t: TableInfo) => t.pageNumber === pageNum);
      const pageLists = documentStructure.lists.filter((l: ListInfo) => l.pageNumber === pageNum);
      const pageLinks = documentStructure.links.filter((l: LinkInfo) => l.pageNumber === pageNum);

      pages.push({
        pageNumber: pageNum,
        width: pageInfo?.width || 0,
        height: pageInfo?.height || 0,
        rotation: pageInfo?.rotation || 0,
        content: this.convertTextContent(pageText),
        images: this.convertImages(pageImages),
        links: this.convertLinks(pageLinks),
        formFields: [], // TODO: Implement form field extraction
        headings: pageHeadings,
        tables: pageTables,
        lists: pageLists,
      });
    }

    return {
      metadata,
      pages,
      structureTree,
      isTagged: metadata.isTagged,
    };
  }

  /**
   * Extract PDF structure tree
   *
   * @param pdfLibDoc - PDF document
   * @returns Structure tree nodes
   */
  private extractStructureTree(pdfLibDoc: import('pdf-lib').PDFDocument): PdfStructureNode[] {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (!(catalog instanceof PDFDict)) {
        return [];
      }

      const structTreeRoot = catalog.get(PDFName.of('StructTreeRoot'));
      if (!(structTreeRoot instanceof PDFDict)) {
        return [];
      }

      const k = structTreeRoot.get(PDFName.of('K'));
      if (!k) {
        return [];
      }

      return this.parseStructureElement(k, pdfLibDoc.context);
    } catch (error) {
      logger.warn(`[PdfComprehensiveParser] Structure tree extraction failed:`, error);
      return [];
    }
  }

  /**
   * Parse structure element recursively
   *
   * @param element - PDF element
   * @param context - PDF context
   * @returns Structure nodes
   */
  private parseStructureElement(
    element: unknown,
    context: import('pdf-lib').PDFContext
  ): PdfStructureNode[] {
    if (element instanceof PDFArray) {
      const nodes: PdfStructureNode[] = [];
      for (const item of element.asArray()) {
        nodes.push(...this.parseStructureElement(item, context));
      }
      return nodes;
    }

    if (element instanceof PDFDict) {
      const node: PdfStructureNode = {
        type: 'unknown',
      };

      // Get structure type
      const sType = element.get(PDFName.of('S'));
      if (sType instanceof PDFName) {
        node.type = sType.asString().replace('/', '');
      }

      // Get ID
      const id = element.get(PDFName.of('ID'));
      if (id instanceof PDFString) {
        node.id = id.decodeText();
      }

      // Get title
      const title = element.get(PDFName.of('T'));
      if (title instanceof PDFString) {
        node.title = title.decodeText();
      }

      // Get alt text
      const alt = element.get(PDFName.of('Alt'));
      if (alt instanceof PDFString) {
        node.alt = alt.decodeText();
      }

      // Get actual text
      const actualText = element.get(PDFName.of('ActualText'));
      if (actualText instanceof PDFString) {
        node.actualText = actualText.decodeText();
      }

      // Get language
      const lang = element.get(PDFName.of('Lang'));
      if (lang instanceof PDFString) {
        node.lang = lang.decodeText();
      }

      // Get children
      const k = element.get(PDFName.of('K'));
      if (k) {
        node.children = this.parseStructureElement(k, context);
      }

      return [node];
    }

    return [];
  }

  /**
   * Convert page text to text content format
   *
   * @param pageText - Page text from text extractor
   * @returns Text content array
   */
  private convertTextContent(pageText: PageText | undefined): PdfTextContent[] {
    if (!pageText) {
      return [];
    }

    const content: PdfTextContent[] = [];

    for (const block of pageText.blocks) {
      for (const line of block.lines) {
        for (const item of line.items) {
          content.push({
            text: item.text,
            position: item.position,
            font: {
              name: item.font.name,
              size: item.font.size,
            },
          });
        }
      }
    }

    return content;
  }

  /**
   * Convert image info to PDF image format
   *
   * @param images - Images from image extractor
   * @returns PDF images
   */
  private convertImages(images: ImageInfo[]): PdfImage[] {
    return images.map(img => ({
      id: img.id,
      position: img.position,
      altText: img.altText,
      actualText: undefined, // ImageInfo doesn't have actualText
      hasAltText: Boolean(img.altText),
    }));
  }

  /**
   * Convert link info to PDF link format
   *
   * @param links - Links from structure analyzer
   * @returns PDF links
   */
  private convertLinks(links: LinkInfo[]): PdfLink[] {
    return links.map(link => ({
      text: link.text,
      url: link.url,
      destination: link.destination,
      position: link.position,
      hasDescriptiveText: link.hasDescriptiveText,
    }));
  }
}

export const pdfComprehensiveParserService = new PdfComprehensiveParserService();
