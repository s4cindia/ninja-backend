/**
 * Document Parser Service
 * Unified interface for parsing PDF, EPUB, DOCX, XML, and TXT documents
 * Used by Editorial Services for citation extraction and plagiarism detection
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { logger } from '../../lib/logger';

export interface TextChunk {
  id: string;
  text: string;
  wordCount: number;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  chapterTitle?: string;
  paragraphIndex: number;
}

export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  publisher?: string;
  publicationDate?: string;
  language?: string;
  pageCount?: number;
  wordCount: number;
  format: 'pdf' | 'epub' | 'docx' | 'xml' | 'txt';
}

export interface DocumentStructure {
  chapters: Array<{
    title: string;
    startOffset: number;
    endOffset: number;
  }>;
  headings: Array<{
    level: number;
    text: string;
    offset: number;
  }>;
}

export interface ParsedDocument {
  text: string;
  chunks: TextChunk[];
  metadata: DocumentMetadata;
  structure: DocumentStructure;
}

type SupportedFormat = 'pdf' | 'epub' | 'docx' | 'xml' | 'txt';

export class DocumentParser {
  private xmlParser: XMLParser;
  private readonly CHUNK_SIZE = 500;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: false,
      trimValues: true,
    });
  }

  /**
   * Main entry point - detects format and delegates to appropriate parser
   */
  async parse(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const format = this.detectFormat(filename);
    logger.info(`[DocumentParser] Parsing ${filename} as ${format}`);
    
    switch (format) {
      case 'pdf':
        return this.parsePDF(buffer);
      case 'epub':
        return this.parseEPUB(buffer);
      case 'docx':
        return this.parseDOCX(buffer);
      case 'xml':
        return this.parseXML(buffer.toString('utf-8'));
      case 'txt':
        return this.parsePlainText(buffer.toString('utf-8'));
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Detect document format from filename extension
   */
  private detectFormat(filename: string): SupportedFormat {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const formatMap: Record<string, SupportedFormat> = {
      'pdf': 'pdf',
      'epub': 'epub',
      'docx': 'docx',
      'xml': 'xml',
      'txt': 'txt',
      'text': 'txt',
    };
    return formatMap[ext] || 'txt';
  }

  /**
   * Parse PDF using pdfjs-dist for text extraction, pdf-lib for metadata
   */
  async parsePDF(buffer: Buffer): Promise<ParsedDocument> {
    const uint8Array = new Uint8Array(buffer);
    
    let metadata: DocumentMetadata = {
      wordCount: 0,
      format: 'pdf',
    };
    
    try {
      const pdfLibDoc = await PDFDocument.load(uint8Array, { ignoreEncryption: true });
      metadata.title = pdfLibDoc.getTitle() || undefined;
      metadata.authors = pdfLibDoc.getAuthor() ? [pdfLibDoc.getAuthor()!] : undefined;
      metadata.pageCount = pdfLibDoc.getPageCount();
    } catch (error) {
      logger.warn('[DocumentParser] Failed to extract PDF metadata with pdf-lib', error instanceof Error ? error : undefined);
    }

    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdfDoc = await loadingTask.promise;
    
    const pageTexts: Array<{ text: string; pageNumber: number }> = [];
    const headings: DocumentStructure['headings'] = [];
    let fullText = '';
    let currentOffset = 0;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const textContent = await page.getTextContent();
      
      let pageText = '';
      let lastY: number | null = null;
      
      for (const item of textContent.items) {
        if ('str' in item) {
          const textItem = item as { str: string; transform: number[] };
          const y = textItem.transform[5];
          
          if (lastY !== null && Math.abs(y - lastY) > 12) {
            pageText += '\n';
          } else if (pageText.length > 0 && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
            pageText += ' ';
          }
          
          pageText += textItem.str;
          lastY = y;
        }
      }
      
      pageText = pageText.trim();
      if (pageText) {
        const headingMatch = pageText.match(/^([A-Z][A-Z\s]{2,50})$/m);
        if (headingMatch) {
          headings.push({
            level: 1,
            text: headingMatch[1].trim(),
            offset: currentOffset,
          });
        }
        
        pageTexts.push({ text: pageText, pageNumber: i });
        fullText += pageText + '\n\n';
        currentOffset += pageText.length + 2;
      }
    }

    fullText = fullText.trim();
    metadata.wordCount = this.countWords(fullText);
    metadata.pageCount = pdfDoc.numPages;

    const chunks = this.chunkTextWithPages(pageTexts);

    return {
      text: fullText,
      chunks,
      metadata,
      structure: {
        chapters: [],
        headings,
      },
    };
  }

  /**
   * Parse EPUB container and extract text in spine order
   */
  async parseEPUB(buffer: Buffer): Promise<ParsedDocument> {
    const zip = new AdmZip(buffer);
    
    const containerXml = zip.readAsText('META-INF/container.xml');
    const container = this.xmlParser.parse(containerXml);
    
    const rootfilePath = this.extractRootfilePath(container);
    if (!rootfilePath) {
      throw new Error('Could not find OPF file path in container.xml');
    }

    const opfContent = zip.readAsText(rootfilePath);
    const opf = this.xmlParser.parse(opfContent);
    const opfDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';

    const metadata = this.extractEpubMetadata(opf);
    const spineItems = this.extractSpineItems(opf, opfDir);
    
    let fullText = '';
    const chapters: DocumentStructure['chapters'] = [];
    const headings: DocumentStructure['headings'] = [];
    let currentOffset = 0;
    let paragraphIndex = 0;

    for (const item of spineItems) {
      try {
        const content = zip.readAsText(item.href);
        const chapterText = this.extractTextFromXHTML(content);
        
        if (chapterText.trim()) {
          const chapterStart = currentOffset;
          
          const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
          const chapterTitle = h1Match ? h1Match[1].trim() : item.id;
          
          chapters.push({
            title: chapterTitle,
            startOffset: chapterStart,
            endOffset: chapterStart + chapterText.length,
          });

          const headingMatches = content.matchAll(/<h([1-6])[^>]*>([^<]+)<\/h\1>/gi);
          for (const match of headingMatches) {
            headings.push({
              level: parseInt(match[1], 10),
              text: match[2].trim(),
              offset: currentOffset + (content.indexOf(match[0]) || 0),
            });
          }

          fullText += chapterText + '\n\n';
          currentOffset += chapterText.length + 2;
          paragraphIndex++;
        }
      } catch (error) {
        logger.warn(`[DocumentParser] Failed to parse EPUB item: ${item.href}`, error instanceof Error ? error : undefined);
      }
    }

    fullText = fullText.trim();
    metadata.wordCount = this.countWords(fullText);

    const chunks = this.chunkText(fullText, 0, chapters);

    return {
      text: fullText,
      chunks,
      metadata,
      structure: { chapters, headings },
    };
  }

  /**
   * Parse DOCX (Office Open XML format)
   */
  async parseDOCX(buffer: Buffer): Promise<ParsedDocument> {
    const zip = new AdmZip(buffer);
    
    let metadata: DocumentMetadata = {
      wordCount: 0,
      format: 'docx',
    };

    try {
      const coreXml = zip.readAsText('docProps/core.xml');
      const core = this.xmlParser.parse(coreXml);
      metadata.title = core?.['cp:coreProperties']?.['dc:title'];
      metadata.authors = core?.['cp:coreProperties']?.['dc:creator'] 
        ? [core['cp:coreProperties']['dc:creator']]
        : undefined;
    } catch {
      logger.warn('[DocumentParser] No core.xml metadata in DOCX');
    }

    const documentXml = zip.readAsText('word/document.xml');
    const doc = this.xmlParser.parse(documentXml);
    
    const { text: fullText, headings } = this.extractTextFromDocx(doc);
    metadata.wordCount = this.countWords(fullText);

    const chunks = this.chunkText(fullText);

    return {
      text: fullText,
      chunks,
      metadata,
      structure: { chapters: [], headings },
    };
  }

  /**
   * Parse XML/JATS content
   */
  async parseXML(xmlContent: string): Promise<ParsedDocument> {
    const parsed = this.xmlParser.parse(xmlContent);
    
    let metadata: DocumentMetadata = {
      wordCount: 0,
      format: 'xml',
    };

    const headings: DocumentStructure['headings'] = [];
    let fullText = '';

    if (parsed.article) {
      const front = parsed.article.front;
      if (front?.['article-meta']) {
        const articleMeta = front['article-meta'];
        metadata.title = articleMeta['title-group']?.['article-title'];
        
        const contribGroup = articleMeta['contrib-group'];
        if (contribGroup?.contrib) {
          const contribs = Array.isArray(contribGroup.contrib) 
            ? contribGroup.contrib 
            : [contribGroup.contrib];
          metadata.authors = contribs
            .filter((c: Record<string, unknown>) => c['@_contrib-type'] === 'author')
            .map((c: Record<string, unknown>) => {
              const name = c.name as Record<string, string> | undefined;
              return name ? `${name.surname}, ${name['given-names']}` : '';
            })
            .filter(Boolean);
        }
      }

      if (parsed.article.body) {
        fullText = this.extractTextFromJatsBody(parsed.article.body, headings);
      }
    } else {
      fullText = this.extractAllText(parsed);
    }

    metadata.wordCount = this.countWords(fullText);
    const chunks = this.chunkText(fullText);

    return {
      text: fullText,
      chunks,
      metadata,
      structure: { chapters: [], headings },
    };
  }

  /**
   * Parse plain text with paragraph detection
   */
  async parsePlainText(text: string): Promise<ParsedDocument> {
    const headings: DocumentStructure['headings'] = [];
    const lines = text.split('\n');
    let offset = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed === trimmed.toUpperCase() && trimmed.length > 3 && trimmed.length < 100) {
        headings.push({ level: 1, text: trimmed, offset });
      } else if (/^\d+\.\s+[A-Z]/.test(trimmed)) {
        headings.push({ level: 2, text: trimmed, offset });
      }
      offset += line.length + 1;
    }

    const metadata: DocumentMetadata = {
      wordCount: this.countWords(text),
      format: 'txt',
    };

    const chunks = this.chunkText(text);

    return {
      text,
      chunks,
      metadata,
      structure: { chapters: [], headings },
    };
  }

  /**
   * Split text into chunks of approximately CHUNK_SIZE words
   */
  private chunkText(
    text: string, 
    baseOffset: number = 0,
    chapters?: DocumentStructure['chapters']
  ): TextChunk[] {
    const chunks: TextChunk[] = [];
    const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
    
    let currentChunk = '';
    let currentWordCount = 0;
    let chunkStart = baseOffset;
    let paragraphIndex = 0;

    for (const sentence of sentences) {
      const sentenceWords = this.countWords(sentence);
      
      if (currentWordCount + sentenceWords > this.CHUNK_SIZE && currentChunk) {
        const chapterTitle = chapters?.find(
          c => chunkStart >= c.startOffset && chunkStart < c.endOffset
        )?.title;

        chunks.push({
          id: `chunk-${chunks.length}`,
          text: currentChunk.trim(),
          wordCount: currentWordCount,
          startOffset: chunkStart,
          endOffset: chunkStart + currentChunk.length,
          chapterTitle,
          paragraphIndex,
        });

        chunkStart += currentChunk.length;
        currentChunk = sentence;
        currentWordCount = sentenceWords;
        paragraphIndex++;
      } else {
        currentChunk += sentence;
        currentWordCount += sentenceWords;
      }
    }

    if (currentChunk.trim()) {
      const chapterTitle = chapters?.find(
        c => chunkStart >= c.startOffset && chunkStart < c.endOffset
      )?.title;

      chunks.push({
        id: `chunk-${chunks.length}`,
        text: currentChunk.trim(),
        wordCount: currentWordCount,
        startOffset: chunkStart,
        endOffset: chunkStart + currentChunk.length,
        chapterTitle,
        paragraphIndex,
      });
    }

    return chunks;
  }

  /**
   * Chunk text while preserving page numbers from PDF
   */
  private chunkTextWithPages(
    pageTexts: Array<{ text: string; pageNumber: number }>
  ): TextChunk[] {
    const chunks: TextChunk[] = [];
    let globalOffset = 0;
    
    for (const { text, pageNumber } of pageTexts) {
      const pageChunks = this.chunkText(text, globalOffset);
      
      for (const chunk of pageChunks) {
        chunks.push({
          ...chunk,
          id: `chunk-${chunks.length}`,
          pageNumber,
        });
      }
      
      globalOffset += text.length + 2;
    }

    return chunks;
  }

  /**
   * Extract text content from XHTML (used by EPUB parser)
   */
  private extractTextFromXHTML(xhtml: string): string {
    let text = xhtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

    text = text
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

    return text.trim();
  }

  /**
   * Extract rootfile path from container.xml
   */
  private extractRootfilePath(container: Record<string, unknown>): string | null {
    try {
      const rootfile = (container as Record<string, Record<string, Record<string, unknown>>>)
        ?.container?.rootfiles?.rootfile;
      if (Array.isArray(rootfile)) {
        return (rootfile[0] as Record<string, string>)?.['@_full-path'] || null;
      }
      return (rootfile as Record<string, string>)?.['@_full-path'] || null;
    } catch {
      return null;
    }
  }

  /**
   * Extract EPUB metadata from OPF
   */
  private extractEpubMetadata(opf: Record<string, unknown>): DocumentMetadata {
    const pkg = opf.package as Record<string, Record<string, unknown>> | undefined;
    const meta = pkg?.metadata;
    
    return {
      title: (meta?.['dc:title'] as string) || undefined,
      authors: meta?.['dc:creator'] 
        ? [meta['dc:creator'] as string].flat() 
        : undefined,
      publisher: (meta?.['dc:publisher'] as string) || undefined,
      language: (meta?.['dc:language'] as string) || undefined,
      wordCount: 0,
      format: 'epub',
    };
  }

  /**
   * Extract spine items from OPF
   */
  private extractSpineItems(
    opf: Record<string, unknown>, 
    opfDir: string
  ): Array<{ id: string; href: string }> {
    const pkg = opf.package as Record<string, unknown> | undefined;
    if (!pkg) return [];

    const manifest = pkg.manifest as Record<string, unknown> | undefined;
    const spine = pkg.spine as Record<string, unknown> | undefined;
    
    if (!manifest?.item || !spine?.itemref) return [];

    const items = Array.isArray(manifest.item) ? manifest.item : [manifest.item];
    const itemrefs = Array.isArray(spine.itemref) ? spine.itemref : [spine.itemref];
    
    const itemMap = new Map<string, string>();
    for (const item of items as Array<Record<string, string>>) {
      if (item['@_id'] && item['@_href']) {
        itemMap.set(item['@_id'], opfDir + item['@_href']);
      }
    }

    const spineItems: Array<{ id: string; href: string }> = [];
    for (const ref of itemrefs as Array<Record<string, string>>) {
      const idref = ref['@_idref'];
      const href = itemMap.get(idref);
      if (idref && href) {
        spineItems.push({ id: idref, href });
      }
    }

    return spineItems;
  }

  /**
   * Extract text from DOCX document.xml structure
   */
  private extractTextFromDocx(doc: Record<string, unknown>): {
    text: string;
    headings: DocumentStructure['headings'];
  } {
    const headings: DocumentStructure['headings'] = [];
    let text = '';
    let offset = 0;

    const body = (doc['w:document'] as Record<string, unknown>)?.['w:body'];
    if (!body) return { text: '', headings: [] };

    const paragraphs = (body as Record<string, unknown>)['w:p'];
    const pArray = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];

    for (const p of pArray as Array<Record<string, unknown>>) {
      const pPr = p['w:pPr'] as Record<string, unknown> | undefined;
      const pStyle = pPr?.['w:pStyle'] as Record<string, string> | undefined;
      const styleId = pStyle?.['@_w:val'] || '';

      let paragraphText = '';
      const runs = p['w:r'];
      const rArray = Array.isArray(runs) ? runs : runs ? [runs] : [];

      for (const r of rArray as Array<Record<string, unknown>>) {
        const textNode = r['w:t'];
        if (typeof textNode === 'string') {
          paragraphText += textNode;
        } else if (textNode && typeof textNode === 'object') {
          paragraphText += (textNode as Record<string, string>)['#text'] || '';
        }
      }

      if (paragraphText) {
        if (styleId.toLowerCase().includes('heading')) {
          const level = parseInt(styleId.replace(/\D/g, ''), 10) || 1;
          headings.push({ level, text: paragraphText, offset });
        }
        text += paragraphText + '\n';
        offset += paragraphText.length + 1;
      }
    }

    return { text: text.trim(), headings };
  }

  /**
   * Extract text from JATS body element
   */
  private extractTextFromJatsBody(
    body: Record<string, unknown>,
    headings: DocumentStructure['headings'],
    offset: number = 0
  ): string {
    let text = '';

    const sections = body.sec;
    const secArray = Array.isArray(sections) ? sections : sections ? [sections] : [];

    for (const sec of secArray as Array<Record<string, unknown>>) {
      const title = sec.title as string | undefined;
      if (title) {
        headings.push({ level: 1, text: title, offset: offset + text.length });
        text += title + '\n\n';
      }

      const paragraphs = sec.p;
      const pArray = Array.isArray(paragraphs) ? paragraphs : paragraphs ? [paragraphs] : [];
      
      for (const p of pArray) {
        const pText = typeof p === 'string' ? p : this.extractAllText(p as Record<string, unknown>);
        text += pText + '\n\n';
      }

      if (sec.sec) {
        text += this.extractTextFromJatsBody(
          { sec: sec.sec } as Record<string, unknown>,
          headings,
          offset + text.length
        );
      }
    }

    return text;
  }

  /**
   * Recursively extract all text content from parsed XML
   */
  private extractAllText(obj: unknown): string {
    if (typeof obj === 'string') return obj;
    if (typeof obj !== 'object' || obj === null) return '';
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.extractAllText(item)).join(' ');
    }

    let text = '';
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('@_')) continue;
      if (key === '#text') {
        text += value + ' ';
      } else {
        text += this.extractAllText(value) + ' ';
      }
    }
    return text.trim();
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }
}

export const documentParser = new DocumentParser();
