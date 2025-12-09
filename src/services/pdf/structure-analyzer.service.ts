import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFNumber } from 'pdf-lib';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { textExtractorService, TextLine, TextBlock, DocumentText } from './text-extractor.service';

export interface HeadingInfo {
  id: string;
  level: number;
  text: string;
  pageNumber: number;
  position: { x: number; y: number };
  isFromTags: boolean;
  isProperlyNested: boolean;
}

export interface HeadingHierarchy {
  headings: HeadingInfo[];
  hasProperHierarchy: boolean;
  hasH1: boolean;
  multipleH1: boolean;
  skippedLevels: Array<{ from: number; to: number; location: string }>;
  issues: Array<{
    type: 'missing-h1' | 'multiple-h1' | 'skipped-level' | 'improper-nesting';
    severity: 'critical' | 'major' | 'minor';
    description: string;
    location: string;
    wcagCriterion: string;
  }>;
}

export interface TableCell {
  row: number;
  column: number;
  text: string;
  isHeader: boolean;
  rowSpan: number;
  colSpan: number;
}

export interface TableInfo {
  id: string;
  pageNumber: number;
  position: { x: number; y: number; width: number; height: number };
  rowCount: number;
  columnCount: number;
  hasHeaderRow: boolean;
  hasHeaderColumn: boolean;
  hasSummary: boolean;
  summary?: string;
  caption?: string;
  cells: TableCell[];
  issues: string[];
  isAccessible: boolean;
}

export interface ListInfo {
  id: string;
  pageNumber: number;
  type: 'ordered' | 'unordered' | 'definition';
  itemCount: number;
  items: Array<{
    text: string;
    marker?: string;
    nested?: ListInfo;
  }>;
  position: { x: number; y: number };
  isProperlyTagged: boolean;
}

export interface LinkInfo {
  id: string;
  pageNumber: number;
  text: string;
  url?: string;
  destination?: number;
  position: { x: number; y: number; width: number; height: number };
  hasDescriptiveText: boolean;
  issues: string[];
}

export interface ReadingOrderInfo {
  isLogical: boolean;
  hasStructureTree: boolean;
  issues: Array<{
    type: 'visual-order' | 'column-confusion' | 'float-interruption' | 'table-reading';
    description: string;
    pageNumber: number;
    location?: string;
  }>;
  confidence: number;
}

export interface LanguageInfo {
  documentLanguage?: string;
  hasDocumentLanguage: boolean;
  languageChanges: Array<{
    language: string;
    pageNumber: number;
    text: string;
  }>;
  issues: string[];
}

export interface DocumentStructure {
  isTaggedPDF: boolean;
  headings: HeadingHierarchy;
  tables: TableInfo[];
  lists: ListInfo[];
  links: LinkInfo[];
  readingOrder: ReadingOrderInfo;
  language: LanguageInfo;
  bookmarks: Array<{ title: string; page?: number; level: number }>;
  formFields: Array<{ name: string; type: string; hasLabel: boolean }>;
  accessibilityScore: number;
  summary: {
    totalHeadings: number;
    totalTables: number;
    totalLists: number;
    totalLinks: number;
    totalImages: number;
    totalFormFields: number;
    criticalIssues: number;
    majorIssues: number;
    minorIssues: number;
  };
}

export interface AnalysisOptions {
  analyzeHeadings?: boolean;
  analyzeTables?: boolean;
  analyzeLists?: boolean;
  analyzeLinks?: boolean;
  analyzeReadingOrder?: boolean;
  analyzeLanguage?: boolean;
  pageRange?: { start: number; end: number };
}

class StructureAnalyzerService {
  async analyzeStructure(
    parsedPdf: ParsedPDF,
    options: AnalysisOptions = {}
  ): Promise<DocumentStructure> {
    const {
      analyzeHeadings = true,
      analyzeTables = true,
      analyzeLists = true,
      analyzeLinks = true,
      analyzeReadingOrder = true,
      analyzeLanguage = true,
      pageRange,
    } = options;

    const isTaggedPDF = parsedPdf.structure.metadata.isTagged;

    const documentText = await textExtractorService.extractText(parsedPdf, {
      pageRange,
      groupIntoLines: true,
      groupIntoBlocks: true,
    });

    const headings = analyzeHeadings
      ? await this.analyzeHeadings(parsedPdf, documentText, isTaggedPDF)
      : this.emptyHeadingHierarchy();

    const tables = analyzeTables
      ? await this.analyzeTables(parsedPdf, documentText, isTaggedPDF)
      : [];

    const lists = analyzeLists
      ? await this.analyzeLists(parsedPdf, documentText, isTaggedPDF)
      : [];

    const links = analyzeLinks
      ? await this.analyzeLinks(parsedPdf)
      : [];

    const readingOrder = analyzeReadingOrder
      ? await this.analyzeReadingOrder(parsedPdf, documentText, isTaggedPDF)
      : { isLogical: true, hasStructureTree: isTaggedPDF, issues: [], confidence: isTaggedPDF ? 0.9 : 0.5 };

    const language = analyzeLanguage
      ? this.analyzeLanguage(parsedPdf, documentText)
      : { hasDocumentLanguage: false, languageChanges: [], issues: [] };

    const bookmarks = this.extractBookmarks(parsedPdf);
    const formFields = await this.analyzeFormFields(parsedPdf);
    const summary = this.calculateSummary(headings, tables, lists, links, formFields);
    const accessibilityScore = this.calculateAccessibilityScore(
      isTaggedPDF,
      headings,
      tables,
      lists,
      links,
      readingOrder,
      language,
      summary,
      analyzeReadingOrder
    );

    return {
      isTaggedPDF,
      headings,
      tables,
      lists,
      links,
      readingOrder,
      language,
      bookmarks,
      formFields,
      accessibilityScore,
      summary,
    };
  }

  private async analyzeHeadings(
    parsedPdf: ParsedPDF,
    documentText: DocumentText,
    isTaggedPDF: boolean
  ): Promise<HeadingHierarchy> {
    const headings: HeadingInfo[] = [];
    const issues: HeadingHierarchy['issues'] = [];

    for (const page of documentText.pages) {
      for (const line of page.lines) {
        if (line.isHeading && line.headingLevel) {
          headings.push({
            id: `h_p${page.pageNumber}_${headings.length}`,
            level: line.headingLevel,
            text: line.text.substring(0, 200),
            pageNumber: page.pageNumber,
            position: { x: line.boundingBox.x, y: line.boundingBox.y },
            isFromTags: false,
            isProperlyNested: true,
          });
        }
      }
    }

    if (isTaggedPDF) {
      const taggedHeadings = await this.extractTaggedHeadings(parsedPdf);
      if (taggedHeadings.length > 0) {
        headings.length = 0;
        headings.push(...taggedHeadings);
      }
    }

    headings.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.position.y - b.position.y;
    });

    const hasH1 = headings.some(h => h.level === 1);
    const h1Count = headings.filter(h => h.level === 1).length;
    const multipleH1 = h1Count > 1;
    const skippedLevels: HeadingHierarchy['skippedLevels'] = [];

    if (!hasH1 && headings.length > 0) {
      issues.push({
        type: 'missing-h1',
        severity: 'major',
        description: 'Document has no H1 heading. Every document should have a main heading.',
        location: 'Document',
        wcagCriterion: '1.3.1',
      });
    }

    if (multipleH1) {
      issues.push({
        type: 'multiple-h1',
        severity: 'minor',
        description: `Document has ${h1Count} H1 headings. Consider using only one main heading.`,
        location: 'Document',
        wcagCriterion: '1.3.1',
      });
    }

    let previousLevel = 0;
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];

      if (previousLevel > 0 && heading.level > previousLevel + 1) {
        const skip = { from: previousLevel, to: heading.level, location: `Page ${heading.pageNumber}` };
        skippedLevels.push(skip);
        headings[i].isProperlyNested = false;

        issues.push({
          type: 'skipped-level',
          severity: 'major',
          description: `Heading level skipped from H${previousLevel} to H${heading.level}: "${heading.text.substring(0, 50)}..."`,
          location: `Page ${heading.pageNumber}`,
          wcagCriterion: '1.3.1',
        });
      }

      previousLevel = heading.level;
    }

    const hasProperHierarchy = issues.filter(i => i.severity !== 'minor').length === 0;

    return {
      headings,
      hasProperHierarchy,
      hasH1,
      multipleH1,
      skippedLevels,
      issues,
    };
  }

  private async extractTaggedHeadings(parsedPdf: ParsedPDF): Promise<HeadingInfo[]> {
    const headings: HeadingInfo[] = [];
    const pageMap = this.buildPageRefMap(parsedPdf.pdfLibDoc);

    try {
      const catalog = parsedPdf.pdfLibDoc.context.lookup(
        parsedPdf.pdfLibDoc.context.trailerInfo.Root
      );

      if (catalog instanceof PDFDict) {
        const structTreeRootRef = catalog.get(PDFName.of('StructTreeRoot'));
        if (structTreeRootRef) {
          const structTreeRoot = parsedPdf.pdfLibDoc.context.lookup(structTreeRootRef);
          if (structTreeRoot instanceof PDFDict) {
            await this.traverseStructureTree(
              structTreeRoot,
              parsedPdf.pdfLibDoc,
              headings,
              1,
              pageMap
            );
          }
        }
      }
    } catch (err) {
      console.warn('Failed to extract tagged headings:', err instanceof Error ? err.message : 'Unknown error');
    }

    return headings;
  }

  private buildPageRefMap(pdfDoc: PDFDocument): Map<string, number> {
    const pageMap = new Map<string, number>();
    try {
      const pages = pdfDoc.getPages();
      for (let i = 0; i < pages.length; i++) {
        const pageRef = pages[i].ref;
        if (pageRef) {
          pageMap.set(pageRef.toString(), i + 1);
        }
      }
    } catch (err) {
      console.warn('Failed to build page reference map:', err instanceof Error ? err.message : 'Unknown error');
    }
    return pageMap;
  }

  private resolvePageNumber(
    node: PDFDict,
    pdfDoc: PDFDocument,
    currentPage: number,
    pageMap: Map<string, number>
  ): number {
    try {
      const pgRef = node.get(PDFName.of('Pg'));
      if (pgRef) {
        const refStr = pgRef.toString();
        if (pageMap.has(refStr)) {
          return pageMap.get(refStr)!;
        }
        const pgObj = pdfDoc.context.lookup(pgRef);
        if (pgObj instanceof PDFDict) {
          const pgObjRef = pgRef.toString();
          if (pageMap.has(pgObjRef)) {
            return pageMap.get(pgObjRef)!;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to resolve page number:', err instanceof Error ? err.message : 'Unknown error');
    }
    return currentPage;
  }

  private async traverseStructureTree(
    node: PDFDict,
    pdfDoc: PDFDocument,
    headings: HeadingInfo[],
    currentPage: number,
    pageMap: Map<string, number>
  ): Promise<void> {
    try {
      const pageNumber = this.resolvePageNumber(node, pdfDoc, currentPage, pageMap);
      const typeRef = node.get(PDFName.of('S'));
      const type = typeRef?.toString();

      if (type && /^\/H[1-6]?$/.test(type)) {
        const level = type === '/H' ? 1 : parseInt(type.replace('/H', ''), 10);

        let text = '';
        const kids = node.get(PDFName.of('K'));
        if (kids instanceof PDFString) {
          text = kids.decodeText();
        }

        headings.push({
          id: `h_tagged_${headings.length}`,
          level,
          text: text || `Heading ${headings.length + 1}`,
          pageNumber,
          position: { x: 0, y: 0 },
          isFromTags: true,
          isProperlyNested: true,
        });
      }

      const kids = node.get(PDFName.of('K'));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          if (kid instanceof PDFDict) {
            await this.traverseStructureTree(kid, pdfDoc, headings, pageNumber, pageMap);
          } else {
            const resolved = pdfDoc.context.lookup(kid);
            if (resolved instanceof PDFDict) {
              await this.traverseStructureTree(resolved, pdfDoc, headings, pageNumber, pageMap);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Structure tree traversal error:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async analyzeTables(
    parsedPdf: ParsedPDF,
    documentText: DocumentText,
    isTaggedPDF: boolean
  ): Promise<TableInfo[]> {
    const tables: TableInfo[] = [];

    for (const page of documentText.pages) {
      const potentialTables = this.detectTabularContent(page.blocks, page.pageNumber);
      tables.push(...potentialTables);
    }

    if (isTaggedPDF) {
      await this.enhanceTablesFromTags(parsedPdf, tables);
    }

    for (const table of tables) {
      this.validateTableAccessibility(table);
    }

    return tables;
  }

  private detectTabularContent(blocks: TextBlock[], pageNumber: number): TableInfo[] {
    const tables: TableInfo[] = [];

    for (const block of blocks) {
      if (block.lines.length >= 2) {
        const columnPositions = this.detectColumnPositions(block.lines);

        if (columnPositions.length >= 2) {
          const table: TableInfo = {
            id: `table_p${pageNumber}_${tables.length}`,
            pageNumber,
            position: block.boundingBox,
            rowCount: block.lines.length,
            columnCount: columnPositions.length,
            hasHeaderRow: false,
            hasHeaderColumn: false,
            hasSummary: false,
            cells: [],
            issues: [],
            isAccessible: false,
          };

          if (block.lines[0]?.items.some(i => i.font.isBold)) {
            table.hasHeaderRow = true;
          }

          const firstItemsBold = block.lines.every(line => 
            line.items[0]?.font.isBold === true
          );
          if (firstItemsBold && block.lines.length > 1) {
            table.hasHeaderColumn = true;
          }

          tables.push(table);
        }
      }
    }

    return tables;
  }

  private detectColumnPositions(lines: TextLine[]): number[] {
    const allXPositions: number[] = [];

    for (const line of lines) {
      for (const item of line.items) {
        allXPositions.push(Math.round(item.position.x / 10) * 10);
      }
    }

    const positionCounts = new Map<number, number>();
    for (const x of allXPositions) {
      positionCounts.set(x, (positionCounts.get(x) || 0) + 1);
    }

    const threshold = lines.length * 0.5;
    const columns = Array.from(positionCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([pos]) => pos)
      .sort((a, b) => a - b);

    return columns;
  }

  private async enhanceTablesFromTags(parsedPdf: ParsedPDF, tables: TableInfo[]): Promise<void> {
    const pageMap = this.buildPageRefMap(parsedPdf.pdfLibDoc);
    const unmatchedTableQueues = new Map<number, TableInfo[]>();
    
    for (const table of tables) {
      if (!unmatchedTableQueues.has(table.pageNumber)) {
        unmatchedTableQueues.set(table.pageNumber, []);
      }
      unmatchedTableQueues.get(table.pageNumber)!.push(table);
    }
    
    const globalQueue = [...tables];

    try {
      const catalog = parsedPdf.pdfLibDoc.context.lookup(
        parsedPdf.pdfLibDoc.context.trailerInfo.Root
      );

      if (catalog instanceof PDFDict) {
        const structTreeRootRef = catalog.get(PDFName.of('StructTreeRoot'));
        if (structTreeRootRef) {
          const structTreeRoot = parsedPdf.pdfLibDoc.context.lookup(structTreeRootRef);
          if (structTreeRoot instanceof PDFDict) {
            await this.findTaggedTables(structTreeRoot, parsedPdf.pdfLibDoc, pageMap, unmatchedTableQueues, globalQueue);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to enhance tables from tags:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async findTaggedTables(
    node: PDFDict,
    pdfDoc: PDFDocument,
    pageMap: Map<string, number>,
    unmatchedTableQueues: Map<number, TableInfo[]>,
    globalQueue: TableInfo[]
  ): Promise<void> {
    try {
      const typeRef = node.get(PDFName.of('S'));
      const type = typeRef?.toString();

      if (type === '/Table') {
        const pageNumber = this.resolvePageNumber(node, pdfDoc, 1, pageMap);
        
        const matchingTable = this.consumeNextTable(pageNumber, unmatchedTableQueues, globalQueue);
        
        if (matchingTable) {
          const summaryRef = node.get(PDFName.of('Summary'));
          if (summaryRef instanceof PDFString) {
            matchingTable.hasSummary = true;
            matchingTable.summary = summaryRef.decodeText();
          }
          
          const captionRef = node.get(PDFName.of('Caption'));
          if (captionRef instanceof PDFString) {
            matchingTable.caption = captionRef.decodeText();
          }
          
          await this.checkTableHeaders(node, pdfDoc, matchingTable);
        }
      }

      const kids = node.get(PDFName.of('K'));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          if (kid instanceof PDFDict) {
            await this.findTaggedTables(kid, pdfDoc, pageMap, unmatchedTableQueues, globalQueue);
          } else {
            const resolved = pdfDoc.context.lookup(kid);
            if (resolved instanceof PDFDict) {
              await this.findTaggedTables(resolved, pdfDoc, pageMap, unmatchedTableQueues, globalQueue);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to find tagged tables:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private consumeNextTable(
    pageNumber: number,
    unmatchedTableQueues: Map<number, TableInfo[]>,
    globalQueue: TableInfo[]
  ): TableInfo | null {
    const pageQueue = unmatchedTableQueues.get(pageNumber);
    if (pageQueue && pageQueue.length > 0) {
      const table = pageQueue.shift()!;
      const globalIndex = globalQueue.indexOf(table);
      if (globalIndex !== -1) {
        globalQueue.splice(globalIndex, 1);
      }
      return table;
    }
    
    if (globalQueue.length > 0) {
      const table = globalQueue.shift()!;
      const tablePageQueue = unmatchedTableQueues.get(table.pageNumber);
      if (tablePageQueue) {
        const pageIndex = tablePageQueue.indexOf(table);
        if (pageIndex !== -1) {
          tablePageQueue.splice(pageIndex, 1);
        }
      }
      return table;
    }
    
    return null;
  }

  private async checkTableHeaders(
    tableNode: PDFDict,
    pdfDoc: PDFDocument,
    table: TableInfo
  ): Promise<void> {
    try {
      const kids = tableNode.get(PDFName.of('K'));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          const resolved = kid instanceof PDFDict ? kid : pdfDoc.context.lookup(kid);
          if (resolved instanceof PDFDict) {
            const typeRef = resolved.get(PDFName.of('S'));
            const type = typeRef?.toString();
            
            if (type === '/THead') {
              table.hasHeaderRow = true;
            } else if (type === '/TH') {
              table.hasHeaderRow = true;
            } else if (type === '/TR') {
              await this.checkRowForHeaders(resolved, pdfDoc, table);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to check table headers:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private async checkRowForHeaders(
    rowNode: PDFDict,
    pdfDoc: PDFDocument,
    table: TableInfo
  ): Promise<void> {
    try {
      const kids = rowNode.get(PDFName.of('K'));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          const resolved = kid instanceof PDFDict ? kid : pdfDoc.context.lookup(kid);
          if (resolved instanceof PDFDict) {
            const typeRef = resolved.get(PDFName.of('S'));
            const type = typeRef?.toString();
            if (type === '/TH') {
              table.hasHeaderRow = true;
              return;
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to check row for headers:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private validateTableAccessibility(table: TableInfo): void {
    if (!table.hasHeaderRow && !table.hasHeaderColumn) {
      table.issues.push('Table has no header cells (TH). Add row or column headers.');
    }

    if (table.rowCount > 5 && !table.hasSummary) {
      table.issues.push('Complex table should have a summary describing its structure.');
    }

    table.isAccessible = table.issues.length === 0 && (table.hasHeaderRow || table.hasHeaderColumn);
  }

  private async analyzeLists(
    parsedPdf: ParsedPDF,
    documentText: DocumentText,
    isTaggedPDF: boolean
  ): Promise<ListInfo[]> {
    const lists: ListInfo[] = [];
    const bulletPatterns = /^[\u2022\u2023\u25E6\u2043\u2219•◦‣⁃○●\-\*]\s/;
    const numberPatterns = /^(\d+[\.\)]\s|[a-z][\.\)]\s|[ivxlcdm]+[\.\)]\s)/i;

    for (const page of documentText.pages) {
      for (const block of page.blocks) {
        if (block.type === 'list') {
          const listItems: ListInfo['items'] = [];
          let listType: ListInfo['type'] = 'unordered';

          for (const line of block.lines) {
            const text = line.text.trim();
            let marker = '';
            let itemText = text;

            if (bulletPatterns.test(text)) {
              marker = text.match(bulletPatterns)?.[0] || '';
              itemText = text.replace(bulletPatterns, '');
              listType = 'unordered';
            } else if (numberPatterns.test(text)) {
              marker = text.match(numberPatterns)?.[0] || '';
              itemText = text.replace(numberPatterns, '');
              listType = 'ordered';
            }

            listItems.push({ text: itemText, marker });
          }

          if (listItems.length > 0) {
            lists.push({
              id: `list_p${page.pageNumber}_${lists.length}`,
              pageNumber: page.pageNumber,
              type: listType,
              itemCount: listItems.length,
              items: listItems,
              position: { x: block.boundingBox.x, y: block.boundingBox.y },
              isProperlyTagged: isTaggedPDF,
            });
          }
        }
      }
    }

    return lists;
  }

  private async analyzeLinks(parsedPdf: ParsedPDF): Promise<LinkInfo[]> {
    const links: LinkInfo[] = [];

    for (let pageNum = 1; pageNum <= parsedPdf.structure.pageCount; pageNum++) {
      try {
        const page = await parsedPdf.pdfjsDoc.getPage(pageNum);
        const annotations = await page.getAnnotations();
        const viewport = page.getViewport({ scale: 1 });

        for (const annot of annotations) {
          if (annot.subtype === 'Link') {
            const rect = annot.rect || [0, 0, 0, 0];
            const link: LinkInfo = {
              id: `link_p${pageNum}_${links.length}`,
              pageNumber: pageNum,
              text: annot.contents || '',
              url: annot.url || undefined,
              destination: typeof annot.dest === 'number' ? annot.dest : undefined,
              position: {
                x: rect[0],
                y: viewport.height - rect[3],
                width: rect[2] - rect[0],
                height: rect[3] - rect[1],
              },
              hasDescriptiveText: false,
              issues: [],
            };

            const text = (link.text || '').trim();
            const nonDescriptivePattern = /^(click|here|link|more|read|download|learn|info)$/i;
            const nonDescriptivePhrases = /^(click here|read more|learn more|more info|download here)$/i;
            const shortAcronymPattern = /^[A-Z0-9]{2,5}$/;
            const whitelist = ['FAQ', 'PDF', 'API', 'URL', 'RSS', 'XML', 'CSV', 'HOME', 'HELP'];

            const isNonDescriptive = nonDescriptivePattern.test(text) || nonDescriptivePhrases.test(text);
            const isWhitelisted = whitelist.includes(text.toUpperCase());
            const isValidAcronym = shortAcronymPattern.test(text) && text === text.toUpperCase();

            if (text && !isNonDescriptive && (text.length > 3 || isWhitelisted || isValidAcronym)) {
              link.hasDescriptiveText = true;
            } else {
              link.issues.push('Link text is not descriptive (WCAG 2.4.4)');
            }

            links.push(link);
          }
        }
      } catch (err) {
        console.warn(`Failed to extract links from page ${pageNum}:`, err instanceof Error ? err.message : 'Unknown error');
      }
    }

    return links;
  }

  private async analyzeReadingOrder(
    parsedPdf: ParsedPDF,
    documentText: DocumentText,
    isTaggedPDF: boolean
  ): Promise<ReadingOrderInfo> {
    const issues: ReadingOrderInfo['issues'] = [];
    let confidence = 0.5;

    if (isTaggedPDF) {
      confidence = 0.9;
    }

    for (const page of documentText.pages) {
      const columnGroups = this.detectColumns(page.lines);

      if (columnGroups.length > 1 && !isTaggedPDF) {
        issues.push({
          type: 'column-confusion',
          description: 'Multi-column layout detected without proper tagging. Reading order may be incorrect.',
          pageNumber: page.pageNumber,
        });
        confidence -= 0.2;
      }
    }

    return {
      isLogical: issues.length === 0 && (isTaggedPDF || documentText.readingOrder === 'left-to-right'),
      hasStructureTree: isTaggedPDF,
      issues,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
  }

  private detectColumns(lines: TextLine[]): number[][] {
    if (lines.length === 0) return [];

    const xRanges: Array<{ minX: number; maxX: number; lines: TextLine[] }> = [];

    for (const line of lines) {
      const lineMinX = line.boundingBox.x;
      const lineMaxX = line.boundingBox.x + line.boundingBox.width;

      let foundGroup = false;
      for (const range of xRanges) {
        if (lineMinX < range.maxX + 50 && lineMaxX > range.minX - 50) {
          range.minX = Math.min(range.minX, lineMinX);
          range.maxX = Math.max(range.maxX, lineMaxX);
          range.lines.push(line);
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup) {
        xRanges.push({ minX: lineMinX, maxX: lineMaxX, lines: [line] });
      }
    }

    const significantRanges = xRanges.filter(r => r.lines.length >= 3);
    return significantRanges.map(r => r.lines.map(l => lines.indexOf(l)));
  }

  private analyzeLanguage(
    parsedPdf: ParsedPDF,
    documentText: DocumentText
  ): LanguageInfo {
    const issues: string[] = [];
    const documentLanguage = parsedPdf.structure.metadata.language;
    const hasDocumentLanguage = !!documentLanguage;

    if (!hasDocumentLanguage) {
      issues.push('Document language is not specified (WCAG 3.1.1). Specify the primary language.');
    }

    const languageChanges: LanguageInfo['languageChanges'] = [];
    const detectedLanguages = documentText.languages || [];

    if (detectedLanguages.length > 1 && !parsedPdf.structure.metadata.isTagged) {
      issues.push('Multiple languages detected but document is not tagged. Language changes may not be marked (WCAG 3.1.2).');
    }

    return {
      documentLanguage,
      hasDocumentLanguage,
      // TODO: Populate languageChanges when per-page/per-region language detection is implemented
      // This would require analyzing text patterns or relying on tagged PDF Lang attributes
      languageChanges,
      issues,
    };
  }

  private extractBookmarks(parsedPdf: ParsedPDF): Array<{ title: string; page?: number; level: number }> {
    const bookmarks: Array<{ title: string; page?: number; level: number }> = [];

    if (parsedPdf.structure.outline) {
      const extractFromOutline = (items: typeof parsedPdf.structure.outline, level: number) => {
        if (!items) return;
        for (const item of items) {
          bookmarks.push({
            title: item.title,
            page: item.destination,
            level,
          });
          if (item.children) {
            extractFromOutline(item.children, level + 1);
          }
        }
      };
      extractFromOutline(parsedPdf.structure.outline, 1);
    }

    return bookmarks;
  }

  private async analyzeFormFields(
    parsedPdf: ParsedPDF
  ): Promise<Array<{ name: string; type: string; hasLabel: boolean }>> {
    const formFields: Array<{ name: string; type: string; hasLabel: boolean }> = [];

    if (!parsedPdf.structure.metadata.hasAcroForm) {
      return formFields;
    }

    try {
      const catalog = parsedPdf.pdfLibDoc.context.lookup(
        parsedPdf.pdfLibDoc.context.trailerInfo.Root
      );

      if (catalog instanceof PDFDict) {
        const acroFormRef = catalog.get(PDFName.of('AcroForm'));
        if (acroFormRef) {
          const acroForm = parsedPdf.pdfLibDoc.context.lookup(acroFormRef);
          if (acroForm instanceof PDFDict) {
            const fieldsRef = acroForm.get(PDFName.of('Fields'));
            if (fieldsRef instanceof PDFArray) {
              for (let i = 0; i < fieldsRef.size(); i++) {
                const fieldRef = fieldsRef.get(i);
                const field = parsedPdf.pdfLibDoc.context.lookup(fieldRef);
                if (field instanceof PDFDict) {
                  const name = field.get(PDFName.of('T'));
                  const fieldType = field.get(PDFName.of('FT'));
                  const tooltip = field.get(PDFName.of('TU'));

                  let type = 'unknown';
                  if (fieldType?.toString() === '/Tx') type = 'text';
                  else if (fieldType?.toString() === '/Btn') type = 'button';
                  else if (fieldType?.toString() === '/Ch') type = 'choice';
                  else if (fieldType?.toString() === '/Sig') type = 'signature';

                  formFields.push({
                    name: name instanceof PDFString ? name.decodeText() : `field_${i}`,
                    type,
                    hasLabel: !!tooltip,
                  });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to extract form fields:', err instanceof Error ? err.message : 'Unknown error');
    }

    return formFields;
  }

  private calculateSummary(
    headings: HeadingHierarchy,
    tables: TableInfo[],
    lists: ListInfo[],
    links: LinkInfo[],
    formFields: Array<{ name: string; type: string; hasLabel: boolean }>
  ): DocumentStructure['summary'] {
    let criticalIssues = 0;
    let majorIssues = 0;
    let minorIssues = 0;

    for (const issue of headings.issues) {
      if (issue.severity === 'critical') criticalIssues++;
      else if (issue.severity === 'major') majorIssues++;
      else minorIssues++;
    }

    for (const table of tables) {
      majorIssues += table.issues.length;
    }

    for (const link of links) {
      minorIssues += link.issues.length;
    }

    return {
      totalHeadings: headings.headings.length,
      totalTables: tables.length,
      totalLists: lists.length,
      totalLinks: links.length,
      totalImages: 0,
      totalFormFields: formFields.length,
      criticalIssues,
      majorIssues,
      minorIssues,
    };
  }

  private calculateAccessibilityScore(
    isTaggedPDF: boolean,
    headings: HeadingHierarchy,
    tables: TableInfo[],
    lists: ListInfo[],
    links: LinkInfo[],
    readingOrder: ReadingOrderInfo,
    language: LanguageInfo,
    summary: DocumentStructure['summary'],
    includeReadingOrder: boolean = true
  ): number {
    let score = 100;

    if (!isTaggedPDF) {
      score -= 30;
    }

    if (!language.hasDocumentLanguage) {
      score -= 10;
    }

    if (!headings.hasH1 && headings.headings.length > 0) {
      score -= 10;
    }

    score -= summary.criticalIssues * 15;
    score -= summary.majorIssues * 5;
    score -= summary.minorIssues * 2;

    const inaccessibleTables = tables.filter(t => !t.isAccessible).length;
    score -= inaccessibleTables * 5;

    if (includeReadingOrder) {
      score -= readingOrder.issues.length * 5;

      if (!readingOrder.isLogical) {
        score -= 10;
      }
    }

    const linksWithoutDescriptive = links.filter(l => !l.hasDescriptiveText).length;
    score -= Math.min(linksWithoutDescriptive, 5) * 2;

    return Math.max(0, Math.min(100, score));
  }

  private emptyHeadingHierarchy(): HeadingHierarchy {
    return {
      headings: [],
      hasProperHierarchy: true,
      hasH1: false,
      multipleH1: false,
      skippedLevels: [],
      issues: [],
    };
  }

  async analyzeFromFile(
    filePath: string,
    options: AnalysisOptions = {}
  ): Promise<DocumentStructure> {
    const parsedPdf = await pdfParserService.parse(filePath);
    try {
      return await this.analyzeStructure(parsedPdf, options);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  async getHeadingsOnly(parsedPdf: ParsedPDF): Promise<HeadingHierarchy> {
    const documentText = await textExtractorService.extractText(parsedPdf, {
      groupIntoLines: true,
      groupIntoBlocks: false,
    });
    return this.analyzeHeadings(parsedPdf, documentText, parsedPdf.structure.metadata.isTagged);
  }

  async getTablesOnly(parsedPdf: ParsedPDF): Promise<TableInfo[]> {
    const documentText = await textExtractorService.extractText(parsedPdf, {
      groupIntoLines: true,
      groupIntoBlocks: true,
    });
    return this.analyzeTables(parsedPdf, documentText, parsedPdf.structure.metadata.isTagged);
  }

  async getLinksOnly(parsedPdf: ParsedPDF): Promise<LinkInfo[]> {
    return this.analyzeLinks(parsedPdf);
  }
}

export const structureAnalyzerService = new StructureAnalyzerService();
