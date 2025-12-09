import { PDFDocument, PDFName, PDFDict, PDFString } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';
import path from 'path';
import { pdfConfig } from '../../config/pdf.config';
import { AppError } from '../../utils/app-error';

const pdfjsWorkerPath = path.join(
  process.cwd(),
  'node_modules',
  'pdfjs-dist',
  'build',
  'pdf.worker.mjs'
);

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerPath;

export interface PDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  language?: string;
  pdfVersion: string;
  isEncrypted: boolean;
  isLinearized: boolean;
  isTagged: boolean;
  hasOutline: boolean;
  hasAcroForm: boolean;
  hasXFA: boolean;
}

export interface PDFPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  hasAnnotations: boolean;
  annotationCount: number;
}

export interface PDFStructure {
  pageCount: number;
  pages: PDFPageInfo[];
  metadata: PDFMetadata;
  outline?: PDFOutlineItem[];
  permissions?: PDFPermissions;
}

export interface PDFOutlineItem {
  title: string;
  destination?: number;
  children?: PDFOutlineItem[];
}

export interface PDFPermissions {
  canPrint: boolean;
  canModify: boolean;
  canCopy: boolean;
  canAnnotate: boolean;
  canFillForms: boolean;
  canExtract: boolean;
  canAssemble: boolean;
  canPrintHighQuality: boolean;
}

export interface ParsedPDF {
  filePath: string;
  fileSize: number;
  structure: PDFStructure;
  pdfLibDoc: PDFDocument;
  pdfjsDoc: pdfjsLib.PDFDocumentProxy;
}

class PDFParserService {
  async parse(filePath: string): Promise<ParsedPDF> {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) {
      throw AppError.notFound('PDF file not found');
    }

    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB > pdfConfig.maxFileSizeMB) {
      throw AppError.badRequest(`PDF file exceeds maximum size of ${pdfConfig.maxFileSizeMB}MB`);
    }

    const fileBuffer = await fs.readFile(filePath);
    const uint8Array = new Uint8Array(fileBuffer);

    const [pdfLibDoc, pdfjsDoc] = await Promise.all([
      this.loadWithPdfLib(fileBuffer),
      this.loadWithPdfjs(uint8Array),
    ]);

    const structure = await this.extractStructure(pdfLibDoc, pdfjsDoc);

    if (structure.pageCount > pdfConfig.maxPages) {
      throw AppError.badRequest(`PDF exceeds maximum page count of ${pdfConfig.maxPages}`);
    }

    return {
      filePath,
      fileSize: stats.size,
      structure,
      pdfLibDoc,
      pdfjsDoc,
    };
  }

  async parseBuffer(buffer: Buffer, fileName = 'document.pdf'): Promise<ParsedPDF> {
    const fileSizeMB = buffer.length / (1024 * 1024);
    if (fileSizeMB > pdfConfig.maxFileSizeMB) {
      throw AppError.badRequest(`PDF file exceeds maximum size of ${pdfConfig.maxFileSizeMB}MB`);
    }

    const uint8Array = new Uint8Array(buffer);

    const [pdfLibDoc, pdfjsDoc] = await Promise.all([
      this.loadWithPdfLib(buffer),
      this.loadWithPdfjs(uint8Array),
    ]);

    const structure = await this.extractStructure(pdfLibDoc, pdfjsDoc);

    if (structure.pageCount > pdfConfig.maxPages) {
      throw AppError.badRequest(`PDF exceeds maximum page count of ${pdfConfig.maxPages}`);
    }

    return {
      filePath: fileName,
      fileSize: buffer.length,
      structure,
      pdfLibDoc,
      pdfjsDoc,
    };
  }

  private async loadWithPdfLib(buffer: Buffer): Promise<PDFDocument> {
    try {
      return await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch (error) {
      throw AppError.badRequest('Failed to parse PDF with pdf-lib: ' + (error as Error).message);
    }
  }

  private async loadWithPdfjs(data: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
    try {
      const loadingTask = pdfjsLib.getDocument({
        data,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
      });
      return await loadingTask.promise;
    } catch (error) {
      throw AppError.badRequest('Failed to parse PDF with pdfjs: ' + (error as Error).message);
    }
  }

  private async extractStructure(
    pdfLibDoc: PDFDocument,
    pdfjsDoc: pdfjsLib.PDFDocumentProxy
  ): Promise<PDFStructure> {
    const metadata = await this.extractMetadata(pdfLibDoc, pdfjsDoc);
    const pages = await this.extractPageInfo(pdfLibDoc, pdfjsDoc);
    const outline = await this.extractOutline(pdfjsDoc);

    return {
      pageCount: pdfjsDoc.numPages,
      pages,
      metadata,
      outline: outline.length > 0 ? outline : undefined,
    };
  }

  private async extractMetadata(
    pdfLibDoc: PDFDocument,
    pdfjsDoc: pdfjsLib.PDFDocumentProxy
  ): Promise<PDFMetadata> {
    const pdfjsMetadata = await pdfjsDoc.getMetadata();
    const info = (pdfjsMetadata.info || {}) as Record<string, unknown>;

    const markInfo = this.getMarkInfo(pdfLibDoc);
    const isTagged = markInfo?.Marked === true;

    const outline = await pdfjsDoc.getOutline();
    const hasOutline = outline !== null && outline.length > 0;

    const language = this.getDocumentLanguage(pdfLibDoc);

    const hasAcroForm = this.hasAcroForm(pdfLibDoc);
    const hasXFA = this.hasXFA(pdfLibDoc);

    return {
      title: (info.Title as string) || pdfLibDoc.getTitle() || undefined,
      author: (info.Author as string) || pdfLibDoc.getAuthor() || undefined,
      subject: (info.Subject as string) || pdfLibDoc.getSubject() || undefined,
      keywords: this.parseKeywords((info.Keywords as string) || pdfLibDoc.getKeywords()),
      creator: (info.Creator as string) || pdfLibDoc.getCreator() || undefined,
      producer: (info.Producer as string) || pdfLibDoc.getProducer() || undefined,
      creationDate: this.parseDate((info.CreationDate as string) || pdfLibDoc.getCreationDate()),
      modificationDate: this.parseDate((info.ModDate as string) || pdfLibDoc.getModificationDate()),
      language,
      pdfVersion: `${(info.PDFFormatVersion as string) || '1.4'}`,
      isEncrypted: !!(info.IsAcroFormPresent as boolean),
      isLinearized: !!(info.IsLinearized as boolean),
      isTagged,
      hasOutline,
      hasAcroForm,
      hasXFA,
    };
  }

  private async extractPageInfo(
    pdfLibDoc: PDFDocument,
    pdfjsDoc: pdfjsLib.PDFDocumentProxy
  ): Promise<PDFPageInfo[]> {
    const pages: PDFPageInfo[] = [];
    const pdfLibPages = pdfLibDoc.getPages();

    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const pdfjsPage = await pdfjsDoc.getPage(i);
      const pdfLibPage = pdfLibPages[i - 1];
      const viewport = pdfjsPage.getViewport({ scale: 1 });
      const annotations = await pdfjsPage.getAnnotations();

      pages.push({
        pageNumber: i,
        width: viewport.width,
        height: viewport.height,
        rotation: pdfLibPage?.getRotation()?.angle || 0,
        hasAnnotations: annotations.length > 0,
        annotationCount: annotations.length,
      });
    }

    return pages;
  }

  private async extractOutline(pdfjsDoc: pdfjsLib.PDFDocumentProxy): Promise<PDFOutlineItem[]> {
    const outline = await pdfjsDoc.getOutline();
    if (!outline) return [];

    const processItems = async (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>): Promise<PDFOutlineItem[]> => {
      const result: PDFOutlineItem[] = [];

      for (const item of items) {
        const outlineItem: PDFOutlineItem = {
          title: item.title || 'Untitled',
        };

        if (item.dest) {
          try {
            if (typeof item.dest === 'string') {
              const dest = await pdfjsDoc.getDestination(item.dest);
              if (dest) {
                const pageIndex = await pdfjsDoc.getPageIndex(dest[0] as unknown as { num: number; gen: number });
                outlineItem.destination = pageIndex + 1;
              }
            } else if (Array.isArray(item.dest)) {
              const pageIndex = await pdfjsDoc.getPageIndex(item.dest[0] as unknown as { num: number; gen: number });
              outlineItem.destination = pageIndex + 1;
            }
          } catch {
            // Ignore destination resolution errors
          }
        }

        if (item.items && item.items.length > 0) {
          outlineItem.children = await processItems(item.items as Array<{ title?: string; dest?: unknown; items?: unknown[] }>);
        }

        result.push(outlineItem);
      }

      return result;
    };

    return processItems(outline as Array<{ title?: string; dest?: unknown; items?: unknown[] }>);
  }

  private getMarkInfo(pdfLibDoc: PDFDocument): { Marked?: boolean } | null {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (catalog instanceof PDFDict) {
        const markInfo = catalog.get(PDFName.of('MarkInfo'));
        if (markInfo instanceof PDFDict) {
          const marked = markInfo.get(PDFName.of('Marked'));
          return { Marked: marked?.toString() === 'true' };
        }
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  private getDocumentLanguage(pdfLibDoc: PDFDocument): string | undefined {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (catalog instanceof PDFDict) {
        const lang = catalog.get(PDFName.of('Lang'));
        if (lang instanceof PDFString) {
          return lang.decodeText();
        }
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  private hasAcroForm(pdfLibDoc: PDFDocument): boolean {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (catalog instanceof PDFDict) {
        return catalog.has(PDFName.of('AcroForm'));
      }
    } catch {
      // Ignore errors
    }
    return false;
  }

  private hasXFA(pdfLibDoc: PDFDocument): boolean {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (catalog instanceof PDFDict) {
        const acroForm = catalog.get(PDFName.of('AcroForm'));
        if (acroForm instanceof PDFDict) {
          return acroForm.has(PDFName.of('XFA'));
        }
      }
    } catch {
      // Ignore errors
    }
    return false;
  }

  private parseKeywords(keywords: string | string[] | undefined): string[] | undefined {
    if (!keywords) return undefined;
    if (Array.isArray(keywords)) return keywords;
    return keywords.split(/[,;]/).map(k => k.trim()).filter(k => k.length > 0);
  }

  private parseDate(date: string | Date | undefined): Date | undefined {
    if (!date) return undefined;
    if (date instanceof Date) return date;

    const pdfDateMatch = date.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (pdfDateMatch) {
      const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = pdfDateMatch;
      return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    }

    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? undefined : parsed;
  }

  async close(parsedPdf: ParsedPDF): Promise<void> {
    try {
      await parsedPdf.pdfjsDoc.destroy();
    } catch {
      // Ignore cleanup errors
    }
  }

  async getPage(parsedPdf: ParsedPDF, pageNumber: number): Promise<pdfjsLib.PDFPageProxy> {
    if (pageNumber < 1 || pageNumber > parsedPdf.structure.pageCount) {
      throw AppError.badRequest(`Invalid page number: ${pageNumber}`);
    }
    return parsedPdf.pdfjsDoc.getPage(pageNumber);
  }
}

export const pdfParserService = new PDFParserService();
