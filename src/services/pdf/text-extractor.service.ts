import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { AppError } from '../../utils/app-error';

export interface TextItem {
  text: string;
  pageNumber: number;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  font: {
    name: string;
    size: number;
    isBold: boolean;
    isItalic: boolean;
  };
  transform: number[];
}

export interface TextLine {
  text: string;
  pageNumber: number;
  items: TextItem[];
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isHeading: boolean;
  headingLevel?: number;
}

export interface TextBlock {
  text: string;
  pageNumber: number;
  lines: TextLine[];
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  type: 'paragraph' | 'heading' | 'list' | 'caption' | 'footer' | 'header' | 'unknown';
}

export interface PageText {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  items: TextItem[];
  lines: TextLine[];
  blocks: TextBlock[];
  wordCount: number;
  characterCount: number;
}

export interface DocumentText {
  pages: PageText[];
  fullText: string;
  totalWords: number;
  totalCharacters: number;
  totalPages: number;
  languages: string[];
  readingOrder: 'left-to-right' | 'right-to-left' | 'mixed';
}

export interface ExtractionOptions {
  includePositions?: boolean;
  includeFontInfo?: boolean;
  groupIntoLines?: boolean;
  groupIntoBlocks?: boolean;
  pageRange?: { start: number; end: number };
  normalizeWhitespace?: boolean;
}

class TextExtractorService {
  private readonly LINE_THRESHOLD = 5;
  private readonly BLOCK_THRESHOLD = 20;
  private readonly HEADING_SIZE_MULTIPLIER = 1.2;

  async extractText(
    parsedPdf: ParsedPDF,
    options: ExtractionOptions = {}
  ): Promise<DocumentText> {
    const {
      includePositions = true,
      includeFontInfo = true,
      groupIntoLines = true,
      groupIntoBlocks = true,
      pageRange,
      normalizeWhitespace = true,
    } = options;

    const pages: PageText[] = [];
    let fullText = '';
    let totalWords = 0;
    let totalCharacters = 0;

    const startPage = pageRange?.start || 1;
    const endPage = pageRange?.end || parsedPdf.structure.pageCount;

    if (startPage < 1 || startPage > parsedPdf.structure.pageCount) {
      throw AppError.badRequest(`Invalid start page: ${startPage}. Document has ${parsedPdf.structure.pageCount} pages.`);
    }
    if (endPage < 1 || endPage > parsedPdf.structure.pageCount) {
      throw AppError.badRequest(`Invalid end page: ${endPage}. Document has ${parsedPdf.structure.pageCount} pages.`);
    }
    if (startPage > endPage) {
      throw AppError.badRequest(`Start page (${startPage}) cannot be greater than end page (${endPage}).`);
    }

    const allFontSizes: number[] = [];

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const page = await parsedPdf.pdfjsDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if ('transform' in item && item.transform) {
          const fontSize = Math.abs(item.transform[0]);
          if (fontSize > 0) allFontSizes.push(fontSize);
        }
      }
    }

    const avgFontSize = allFontSizes.length > 0
      ? allFontSizes.reduce((a, b) => a + b, 0) / allFontSizes.length
      : 12;
    const headingThreshold = avgFontSize * this.HEADING_SIZE_MULTIPLIER;

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const pageText = await this.extractPageText(
        parsedPdf.pdfjsDoc,
        pageNum,
        {
          includePositions,
          includeFontInfo,
          groupIntoLines,
          groupIntoBlocks,
          normalizeWhitespace,
          headingThreshold,
          avgFontSize,
        }
      );

      pages.push(pageText);
      fullText += pageText.text + '\n\n';
      totalWords += pageText.wordCount;
      totalCharacters += pageText.characterCount;
    }

    const readingOrder = this.detectReadingOrder(pages.slice(0, 3));
    const languages = this.detectLanguages(fullText);

    return {
      pages,
      fullText: normalizeWhitespace ? this.normalizeText(fullText) : fullText,
      totalWords,
      totalCharacters,
      totalPages: pages.length,
      languages,
      readingOrder,
    };
  }

  private async extractPageText(
    pdfjsDoc: pdfjsLib.PDFDocumentProxy,
    pageNumber: number,
    options: {
      includePositions: boolean;
      includeFontInfo: boolean;
      groupIntoLines: boolean;
      groupIntoBlocks: boolean;
      normalizeWhitespace: boolean;
      headingThreshold: number;
      avgFontSize: number;
    }
  ): Promise<PageText> {
    const page = await pdfjsDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const items: TextItem[] = [];
    const commonFonts = await this.getCommonFonts(page);

    for (const item of textContent.items) {
      if (!('str' in item) || !item.str) continue;

      const textItem = this.processTextItem(item, pageNumber, viewport, commonFonts);
      if (textItem) {
        items.push(textItem);
      }
    }

    items.sort((a, b) => {
      const yDiff = a.position.y - b.position.y;
      if (Math.abs(yDiff) > this.LINE_THRESHOLD) return yDiff;
      return a.position.x - b.position.x;
    });

    const lines = options.groupIntoLines
      ? this.groupIntoLines(items, options.headingThreshold, options.avgFontSize)
      : [];

    const blocks = options.groupIntoBlocks && lines.length > 0
      ? this.groupIntoBlocks(lines)
      : [];

    const pageText = lines.length > 0
      ? lines.map(l => l.text).join('\n')
      : items.map(i => i.text).join(' ');

    const normalizedText = options.normalizeWhitespace
      ? this.normalizeText(pageText)
      : pageText;

    const strippedItems = options.includePositions || options.includeFontInfo
      ? items.map(item => this.stripTextItemData(item, options.includePositions, options.includeFontInfo))
      : [];

    return {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      text: normalizedText,
      items: strippedItems,
      lines,
      blocks,
      wordCount: this.countWords(normalizedText),
      characterCount: normalizedText.length,
    };
  }

  private processTextItem(
    item: Record<string, unknown>,
    pageNumber: number,
    viewport: pdfjsLib.PageViewport,
    commonFonts: Map<string, unknown>
  ): TextItem | null {
    const text = item.str;
    if (!text.trim()) return null;

    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const fontSize = Math.abs(transform[0]) || 12;
    const x = transform[4];
    const y = viewport.height - transform[5];
    const width = item.width || text.length * fontSize * 0.6;
    const height = fontSize;

    const fontName = item.fontName || 'unknown';
    const fontInfo = commonFonts.get(fontName) || {};
    const isBold = fontInfo.bold || /bold/i.test(fontName);
    const isItalic = fontInfo.italic || /italic|oblique/i.test(fontName);

    return {
      text,
      pageNumber,
      position: { x, y, width, height },
      font: { name: fontName, size: fontSize, isBold, isItalic },
      transform,
    };
  }

  private stripTextItemData(item: TextItem, includePositions: boolean, includeFontInfo: boolean): TextItem {
    return {
      ...item,
      position: includePositions ? item.position : { x: 0, y: 0, width: 0, height: 0 },
      font: includeFontInfo ? item.font : { name: '', size: 0, isBold: false, isItalic: false },
    };
  }

  private async getCommonFonts(page: pdfjsLib.PDFPageProxy): Promise<Map<string, any>> {
    const fonts = new Map<string, any>();
    try {
      await page.getOperatorList();
    } catch {
    }
    return fonts;
  }

  private groupIntoLines(
    items: TextItem[],
    headingThreshold: number,
    avgFontSize: number
  ): TextLine[] {
    if (items.length === 0) return [];

    const lines: TextLine[] = [];
    let currentLine: TextItem[] = [items[0]];
    let currentY = items[0].position.y;

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      const yDiff = Math.abs(item.position.y - currentY);

      if (yDiff <= this.LINE_THRESHOLD) {
        currentLine.push(item);
      } else {
        lines.push(this.createLine(currentLine, headingThreshold, avgFontSize));
        currentLine = [item];
        currentY = item.position.y;
      }
    }

    if (currentLine.length > 0) {
      lines.push(this.createLine(currentLine, headingThreshold, avgFontSize));
    }

    return lines;
  }

  private createLine(
    items: TextItem[],
    headingThreshold: number,
    avgFontSize: number
  ): TextLine {
    items.sort((a, b) => a.position.x - b.position.x);

    const text = items.map(i => i.text).join(' ');
    const pageNumber = items[0].pageNumber;

    const minX = Math.min(...items.map(i => i.position.x));
    const minY = Math.min(...items.map(i => i.position.y));
    const maxX = Math.max(...items.map(i => i.position.x + i.position.width));
    const maxY = Math.max(...items.map(i => i.position.y + i.position.height));

    const avgLineFontSize = items.reduce((sum, i) => sum + i.font.size, 0) / items.length;
    const isHeading = avgLineFontSize >= headingThreshold || items.some(i => i.font.isBold);
    const headingLevel = isHeading ? this.detectHeadingLevel(avgLineFontSize, avgFontSize) : undefined;

    return {
      text,
      pageNumber,
      items,
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      isHeading,
      headingLevel,
    };
  }

  private detectHeadingLevel(fontSize: number, avgFontSize: number): number {
    const ratio = fontSize / avgFontSize;
    if (ratio >= 2.0) return 1;
    if (ratio >= 1.7) return 2;
    if (ratio >= 1.4) return 3;
    if (ratio >= 1.2) return 4;
    return 5;
  }

  private groupIntoBlocks(lines: TextLine[]): TextBlock[] {
    if (lines.length === 0) return [];

    const blocks: TextBlock[] = [];
    let currentBlock: TextLine[] = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const prevLine = currentBlock[currentBlock.length - 1];
      const yGap = line.boundingBox.y - (prevLine.boundingBox.y + prevLine.boundingBox.height);

      if (yGap <= this.BLOCK_THRESHOLD && !prevLine.isHeading) {
        currentBlock.push(line);
      } else {
        blocks.push(this.createBlock(currentBlock));
        currentBlock = [line];
      }
    }

    if (currentBlock.length > 0) {
      blocks.push(this.createBlock(currentBlock));
    }

    return blocks;
  }

  private createBlock(lines: TextLine[]): TextBlock {
    const text = lines.map(l => l.text).join('\n');
    const pageNumber = lines[0].pageNumber;

    const minX = Math.min(...lines.map(l => l.boundingBox.x));
    const minY = Math.min(...lines.map(l => l.boundingBox.y));
    const maxX = Math.max(...lines.map(l => l.boundingBox.x + l.boundingBox.width));
    const maxY = Math.max(...lines.map(l => l.boundingBox.y + l.boundingBox.height));

    const type = this.detectBlockType(lines, text);

    return {
      text,
      pageNumber,
      lines,
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      type,
    };
  }

  private detectBlockType(
    lines: TextLine[],
    text: string
  ): TextBlock['type'] {
    if (lines.length === 1 && lines[0].isHeading) {
      return 'heading';
    }

    const listPattern = /^[\u2022\u2023\u25E6\u2043\u2219•◦‣⁃○●\-\*]\s|^\d+[\.\)]\s|^[a-z][\.\)]\s/im;
    if (listPattern.test(text)) {
      return 'list';
    }

    const avgFontSize = lines.reduce((sum, l) =>
      sum + l.items.reduce((s, i) => s + i.font.size, 0) / l.items.length, 0
    ) / lines.length;
    if (avgFontSize < 10 && lines[0].boundingBox.y > 700) {
      return 'footer';
    }

    if (avgFontSize < 10 && lines[0].boundingBox.y < 50) {
      return 'header';
    }

    if (text.length < 200 && /^(figure|fig\.|table|image|photo)/i.test(text)) {
      return 'caption';
    }

    return lines.length > 0 ? 'paragraph' : 'unknown';
  }

  private detectReadingOrder(pages: PageText[]): 'left-to-right' | 'right-to-left' | 'mixed' {
    let ltrCount = 0;
    let rtlCount = 0;

    for (const page of pages) {
      for (const line of page.lines) {
        if (line.items.length > 1) {
          const firstX = line.items[0].position.x;
          const lastX = line.items[line.items.length - 1].position.x;
          if (firstX < lastX) ltrCount++;
          else rtlCount++;
        }
      }
    }

    if (ltrCount > rtlCount * 2) return 'left-to-right';
    if (rtlCount > ltrCount * 2) return 'right-to-left';
    return 'mixed';
  }

  private detectLanguages(text: string): string[] {
    const languages: string[] = [];

    if (/[\u0000-\u007F]/.test(text)) languages.push('en');
    if (/[\u0400-\u04FF]/.test(text)) languages.push('ru');
    if (/[\u4E00-\u9FFF]/.test(text)) languages.push('zh');
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) languages.push('ja');
    if (/[\uAC00-\uD7AF]/.test(text)) languages.push('ko');
    if (/[\u0600-\u06FF]/.test(text)) languages.push('ar');
    if (/[\u0900-\u097F]/.test(text)) languages.push('hi');

    return languages.length > 0 ? languages : ['unknown'];
  }

  private normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }

  async extractFromFile(
    filePath: string,
    options: ExtractionOptions = {}
  ): Promise<DocumentText> {
    const parsedPdf = await pdfParserService.parse(filePath);
    try {
      return await this.extractText(parsedPdf, options);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  async extractPages(
    parsedPdf: ParsedPDF,
    pageNumbers: number[],
    options: ExtractionOptions = {}
  ): Promise<PageText[]> {
    for (const pageNum of pageNumbers) {
      if (pageNum < 1 || pageNum > parsedPdf.structure.pageCount) {
        throw AppError.badRequest(`Invalid page number: ${pageNum}. Document has ${parsedPdf.structure.pageCount} pages.`);
      }
    }

    const pages: PageText[] = [];
    const allFontSizes: number[] = [];

    for (const pageNum of pageNumbers) {
      const page = await parsedPdf.pdfjsDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        if ('transform' in item && item.transform) {
          const fontSize = Math.abs(item.transform[0]);
          if (fontSize > 0) allFontSizes.push(fontSize);
        }
      }
    }

    const avgFontSize = allFontSizes.length > 0
      ? allFontSizes.reduce((a, b) => a + b, 0) / allFontSizes.length
      : 12;
    const headingThreshold = avgFontSize * this.HEADING_SIZE_MULTIPLIER;

    for (const pageNum of pageNumbers) {
      const pageText = await this.extractPageText(
        parsedPdf.pdfjsDoc,
        pageNum,
        {
          includePositions: options.includePositions ?? true,
          includeFontInfo: options.includeFontInfo ?? true,
          groupIntoLines: options.groupIntoLines ?? true,
          groupIntoBlocks: options.groupIntoBlocks ?? true,
          normalizeWhitespace: options.normalizeWhitespace ?? true,
          headingThreshold,
          avgFontSize,
        }
      );
      pages.push(pageText);
    }

    return pages;
  }
}

export const textExtractorService = new TextExtractorService();
