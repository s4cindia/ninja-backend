/**
 * Comprehensive PDF Parser Service
 *
 * Integrates pdf-lib and pdfjs-dist to extract complete PDF structure,
 * metadata, and content for accessibility auditing.
 *
 * Implements US-PDF-1.1 requirements
 */

import { logger } from '../../lib/logger';
import { pdfConfig } from '../../config/pdf.config';
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
  pageLabels?: string[];
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
  /** Low-level parsed PDF for validators - must be closed after use */
  parsedPdf?: ParsedPDF;
  /**
   * Absolute path to the PDF on disk.
   * Set by parse() when given a real file path, or set by runAuditFromBuffer()
   * after writing a temp file for veraPDF. Undefined when processing an
   * in-memory buffer without a temp file.
   */
  filePath?: string;
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

      // Expose parsedPdf and filePath for downstream validators (incl. veraPDF)
      result.parsedPdf = parsedPdf;
      result.filePath = filePath;

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
  async parseBuffer(
    buffer: Buffer,
    fileName = 'document.pdf',
    onProgress?: (currentPage: number, totalPages: number) => void
  ): Promise<PdfParseResult> {
    let parsedPdf: ParsedPDF | null = null;

    try {
      logger.info(`[PdfComprehensiveParser] Parsing PDF buffer: ${fileName}`);

      // Parse with base parser
      parsedPdf = await pdfParserService.parseBuffer(buffer, fileName);

      // Extract comprehensive content
      const result = await this.extractComprehensiveContent(parsedPdf, onProgress);

      // Include parsedPdf for validators to use
      // NOTE: Caller is responsible for closing parsedPdf after validation
      result.parsedPdf = parsedPdf;

      logger.info(`[PdfComprehensiveParser] Parse complete: ${result.pages.length} pages, tagged=${result.isTagged}`);

      return result;
    } catch (error) {
      logger.error(`[PdfComprehensiveParser] Parse buffer failed:`, error);
      // Only close on error - success case leaves it open for validators
      if (parsedPdf) {
        try {
          await pdfParserService.close(parsedPdf);
        } catch (closeError) {
          logger.warn('[PdfComprehensiveParser] Failed to close PDF handle:', closeError);
        }
      }
      throw error;
    }
  }

  /**
   * Extract comprehensive content from parsed PDF
   *
   * @param parsedPdf - Base parsed PDF
   * @returns Complete parse result
   */
  private async extractComprehensiveContent(
    parsedPdf: ParsedPDF,
    onProgress?: (currentPage: number, totalPages: number) => void
  ): Promise<PdfParseResult> {
    const { structure, pdfLibDoc } = parsedPdf;

    // Apply dev page cap if set (MAX_AUDIT_PAGES env var)
    const cap = pdfConfig.maxAuditPages;
    if (cap > 0 && structure.pageCount > cap) {
      logger.warn(`[PdfComprehensiveParser] MAX_AUDIT_PAGES=${cap} — auditing first ${cap} of ${structure.pageCount} pages`);
      structure.pageCount = cap;
      structure.pages = structure.pages.slice(0, cap);
    }
    const totalPages = structure.pageCount;

    // Signal total page count immediately so the frontend can display it
    onProgress?.(0, totalPages);

    // Extract metadata
    const metadata: PdfMetadata = {
      ...structure.metadata,
      pageCount: structure.pageCount,
      hasStructureTree: structure.metadata.isTagged,
      pageLabels: structure.pageLabels,
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

    // Extract text and images in parallel (independent operations)
    // Text extraction emits per-batch page progress covering pages 1→totalPages.
    // Image extraction runs alongside but doesn't emit its own progress.
    logger.info(`[PdfComprehensiveParser] Extracting text and images in parallel...`);
    const [documentText, documentImages] = await Promise.all([
      textExtractorService.extractText(parsedPdf, {}, onProgress
        ? (processed, total) => onProgress(Math.min(processed, total), total)
        : undefined),
      imageExtractorService.extractImages(parsedPdf),
    ]);

    // Structure analysis runs after (internally re-extracts text for heading analysis)
    logger.info(`[PdfComprehensiveParser] Analyzing structure...`);
    const documentStructure = await structureAnalyzerService.analyzeStructure(parsedPdf);

    // Extract form fields using pdfjs annotation API (non-fatal if it fails)
    const documentFormFields = await this.extractAllFormFields(parsedPdf.pdfjsDoc, structure.pageCount);

    // Signal completion of all extraction phases
    onProgress?.(totalPages, totalPages);

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
        formFields: documentFormFields.get(pageNum) ?? [],
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

  /**
   * Extract form fields from all pages using pdfjs Widget annotations.
   * Returns a map of pageNumber → PdfFormField[].
   * Non-fatal: returns empty map on any extraction error.
   */
  private async extractAllFormFields(
    pdfjsDoc: import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy,
    pageCount: number
  ): Promise<Map<number, PdfFormField[]>> {
    const result = new Map<number, PdfFormField[]>();
    try {
      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const page = await pdfjsDoc.getPage(pageNum);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const annotations: any[] = await (page as any).getAnnotations({ intent: 'display' });
        const formFields: PdfFormField[] = annotations
          .filter(a => a.subtype === 'Widget')
          .map(a => {
            const rect: [number, number, number, number] = a.rect ?? [0, 0, 0, 0];
            return {
              name: String(a.fieldName ?? ''),
              type: this.mapFormFieldType(a),
              label: String(a.alternativeText ?? a.fieldName ?? ''),
              value: Array.isArray(a.fieldValue)
                ? String(a.fieldValue[0] ?? '')
                : String(a.fieldValue ?? ''),
              required: Boolean(a.required),
              position: {
                x: rect[0],
                y: rect[1],
                width: Math.abs(rect[2] - rect[0]),
                height: Math.abs(rect[3] - rect[1]),
              },
            } satisfies PdfFormField;
          });
        if (formFields.length > 0) {
          result.set(pageNum, formFields);
        }
      }
    } catch (err) {
      logger.warn('[PdfComprehensiveParser] Form field extraction failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapFormFieldType(annotation: any): PdfFormField['type'] {
    switch (annotation.fieldType) {
      case 'Tx': return 'text';
      case 'Ch': return 'select';
      case 'Btn':
        if (annotation.checkBox) return 'checkbox';
        if (annotation.radioButton) return 'radio';
        return 'button';
      default: return 'text';
    }
  }
}

export const pdfComprehensiveParserService = new PdfComprehensiveParserService();
