import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString } from 'pdf-lib';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { textExtractorService, TextLine, TextBlock, DocumentText } from './text-extractor.service';

// detectTabularContent's minimum bar for a second (and beyond) column to
// count as "genuinely part of the table" rather than rare incidental
// spillover -- see isGenuinelyTabular's doc comment for the real,
// previously-undiscovered false-positive class this guards against.
const MIN_COLUMN_POPULATION_FRACTION = 0.3;
// How many columns must each clear that population bar before a
// layout-detected grid is trusted as a real table.
const MIN_TABULAR_COLUMNS = 2;
// Recognized bullet/ordered-list marker syntax -- a bare bullet glyph, or a
// number/letter/roman-numeral immediately followed by a list delimiter
// (., ), or :). A column where EVERY populated cell matches this is treated
// as a list-marker column, not real tabular data -- see isGenuinelyTabular's
// doc comment. Deliberately does NOT match a bare number/letter alone (e.g.
// "5", "a", or a repeated categorical value like "Yes") -- those are real
// short/categorical data until unambiguously formatted as a list marker; a
// dominance-based check (an earlier version of this fix) wrongly rejected a
// repeated "Yes"/"No" column and wrongly accepted a "1.", "2.", "3." ordered
// list (no single distinct value dominates) -- both real CodeRabbit review
// findings on this fix, fixed by matching marker SYNTAX instead of relying
// on how often a value repeats.
const LIST_MARKER_PATTERN = /^(?:[•◦▪▫■□●○‣∙·\-*]|[0-9]{1,3}[.):]|[a-zA-Z][.):]|[ivxlcdmIVXLCDM]{1,6}[.):])$/;

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
    pageNumber?: number;
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
  /** True when this table was matched to a /Table structure tree element */
  structureMatched?: boolean;
  /**
   * 0-based index among /Table structure elements on this page, in
   * document order — set only when structureMatched. Lets a later
   * apply-time step re-locate the exact same StructElem positionally
   * (pdfModifierService.setActualText's elementsOnPage[index] matching),
   * since Table elements are containers with no MCID of their own to
   * match by, unlike Formula/Figure leaves.
   */
  structureElementIndex?: number;
  /**
   * True when this table was paired with its /Table structure element via
   * the global-queue fallback (no layout-detected candidate was left queued
   * for the element's own resolved page) -- pageNumber was reassigned to
   * that element's real page, but cells/rowCount/columnCount/position still
   * reflect the ORIGINAL (different) page's text-layout content. Safe for
   * consumers that only touch the struct element itself (e.g.
   * table-header-fix's mechanical TD->TH promotion), not for anything that
   * drafts content FROM cells and writes it back (e.g. table-summary) --
   * such consumers should downgrade to guidance-only / human review rather
   * than auto-apply text that may describe a different page's content.
   */
  pageReassigned?: boolean;
  /**
   * Total count of /Table structure elements resolved to this table's real
   * page (pageNumber), matched or not -- set only when structureMatched.
   * Lets a pageReassigned consumer (e.g. table-summary drafting, which must
   * render the whole real page rather than a per-table region since
   * position/cells are stale) tell an unambiguous single-table page (safe to
   * auto-apply the drafted summary to) from a genuinely multi-table one
   * (can't confirm which table the render described -- stays guidance-only).
   */
  tablesOnRealPage?: number;
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
        pageNumber: 1,
        wcagCriterion: '1.3.1',
      });
    }

    if (multipleH1) {
      issues.push({
        type: 'multiple-h1',
        severity: 'minor',
        description: `Document has ${h1Count} H1 headings. Consider using only one main heading.`,
        location: 'Document',
        pageNumber: 1,
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
          pageNumber: heading.pageNumber,
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

  /**
   * currentPage/return type is `number | null` so findTaggedTables's walk can
   * thread a genuine "not yet known" through non-/Table ancestors (Document,
   * StructTreeRoot, etc.) without this method silently manufacturing a page
   * for them -- coercing to a default here would re-poison resolveTablePageNumber's
   * own null result for any /Table nested under such an ancestor (i.e. nearly
   * all of them), defeating that fix entirely. traverseStructureTree (headings)
   * always seeds a real number, so it never observes a null here and its
   * behavior is unchanged.
   */
  private resolvePageNumber(
    node: PDFDict,
    pdfDoc: PDFDocument,
    currentPage: number | null,
    pageMap: Map<string, number>
  ): number | null {
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

  /**
   * resolvePageNumber, plus a descendant search for taggers (e.g. Seam C)
   * that never put /Pg on the /Table node or any ancestor -- only on leaf
   * row/cell descendants. Falls back to the ancestor-inherited currentPage
   * only once both the node's own /Pg and its subtree are exhausted.
   *
   * currentPage (and the return value) is `number | null`: null means no
   * real /Pg has ever been resolved anywhere in this element's ancestor
   * chain either -- it must NOT be defaulted to a fabricated page (the
   * findTaggedTables walk seeds the root as null, not 1, for exactly this
   * reason). A /Table whose own /Pg, subtree, AND ancestor chain all lack
   * /Pg (root-caused live: 14 tables on an 805-page document all silently
   * collapsing onto a fictional "page 1", corrupting pageNumber/pageReassigned
   * and permanently failing table-header-fix apply with "No Table element
   * found" for that fake page) must stay unresolved so the caller can skip
   * pairing it, instead of inheriting a placeholder that was never actually
   * observed on any ancestor.
   */
  private resolveTablePageNumber(
    node: PDFDict,
    pdfDoc: PDFDocument,
    pageMap: Map<string, number>,
    currentPage: number | null
  ): number | null {
    const direct = this.resolveDirectPageNumber(node, pdfDoc, pageMap);
    if (direct !== null) return direct;

    const fromDescendants = this.findPageNumberInSubtree(node, pdfDoc, pageMap, 6);
    if (fromDescendants !== null) return fromDescendants;

    return currentPage;
  }

  private resolveDirectPageNumber(
    node: PDFDict,
    pdfDoc: PDFDocument,
    pageMap: Map<string, number>
  ): number | null {
    try {
      const pgRef = node.get(PDFName.of('Pg'));
      if (!pgRef) return null;
      const refStr = pgRef.toString();
      if (pageMap.has(refStr)) return pageMap.get(refStr)!;
    } catch (err) {
      console.warn('Failed to resolve direct page number:', err instanceof Error ? err.message : 'Unknown error');
    }
    return null;
  }

  private findPageNumberInSubtree(
    node: PDFDict,
    pdfDoc: PDFDocument,
    pageMap: Map<string, number>,
    maxDepth: number
  ): number | null {
    if (maxDepth <= 0) return null;

    try {
      const kids = node.get(PDFName.of('K'));
      const children: PDFDict[] = [];
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          const resolved = kid instanceof PDFDict ? kid : pdfDoc.context.lookup(kid);
          if (resolved instanceof PDFDict) children.push(resolved);
        }
      } else if (kids instanceof PDFDict) {
        children.push(kids);
      } else if (kids) {
        const resolved = pdfDoc.context.lookup(kids);
        if (resolved instanceof PDFDict) children.push(resolved);
      }

      for (const child of children) {
        const direct = this.resolveDirectPageNumber(child, pdfDoc, pageMap);
        if (direct !== null) return direct;
      }
      for (const child of children) {
        const nested = this.findPageNumberInSubtree(child, pdfDoc, pageMap, maxDepth - 1);
        if (nested !== null) return nested;
      }
    } catch (err) {
      console.warn('Failed to search subtree for page number:', err instanceof Error ? err.message : 'Unknown error');
    }
    return null;
  }

  private async traverseStructureTree(
    node: PDFDict,
    pdfDoc: PDFDocument,
    headings: HeadingInfo[],
    currentPage: number,
    pageMap: Map<string, number>
  ): Promise<void> {
    try {
      // This walk always seeds/threads a real number (unlike findTaggedTables,
      // which intentionally threads null) -- the `?? currentPage` here is a
      // type-level safety net only, never a real fallback in practice.
      const pageNumber = this.resolvePageNumber(node, pdfDoc, currentPage, pageMap) ?? currentPage;
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
      // For tagged PDFs, discard text-layout "tables" that have no matching /Table
      // structure element — they are false positives from the content detector.
      //
      // Deliberately does NOT also apply isGenuinelyTabular here (a real
      // finding from PR #542's review): enhanceTablesFromTags does
      // POSITIONAL matching against every candidate in `tables` -- removing
      // one beforehand doesn't remove the real /Table struct element it
      // would have paired with, it just leaves that element to be force-
      // paired with a DIFFERENT, unrelated candidate via consumeNextTable's
      // global-queue fallback, corrupting that pairing instead. A confirmed
      // structural /Table match is trusted over the layout-only heuristic
      // unconditionally; isGenuinelyTabular only ever filters the untagged
      // branch below, where no struct tree exists to corroborate at all.
      const matched = tables.filter(t => t.structureMatched);
      for (const table of matched) {
        // enhanceTablesFromTags may have flipped hasHeaderRow/hasHeaderColumn
        // from tag data (/THead, /TH) after cells were built from the bold
        // heuristic alone — resync so cell.isHeader reflects the final flags.
        this.syncCellHeaderFlags(table);
        this.validateTableAccessibility(table);

        // Re-key the id onto structureElementIndex (the Nth /Table on this
        // page in structure-tree document order) instead of the layout
        // detector's incidental per-page push order. pdfModifierService
        // writers (setTableSummary et al.) parse this same "table_p{page}_{n}"
        // id back into a page+index and use it to index into the structure
        // tree's own per-page /Table list -- if n were left as the detection
        // order, it would almost never line up with that list's order,
        // silently writing to the wrong /Table element (e.g. a page with
        // >1 table, or a document-tree walk that doesn't visit tables in
        // detection order at all).
        table.id = `table_p${table.pageNumber}_${table.structureElementIndex}`;
      }

      // A table whose tagged rows straddle a page boundary can make
      // consumeNextTable's per-page queue come up short, falling back to the
      // global queue and pairing a /Table node resolved to page N with a
      // TableInfo whose own (layout-detected) pageNumber isn't N -- rare, but
      // when two such mismatches land on the same resolved page they can
      // collide on the same structureElementIndex, producing a duplicate id.
      // Left alone, a duplicate silently overwrites a distinct table in any
      // Map keyed by id downstream (ai-analysis.service.ts's tableById) --
      // disambiguate here so every matched table keeps a unique identity,
      // even though the id no longer perfectly encodes its true structural
      // position in that rare case.
      const seenIds = new Map<string, number>();
      for (const table of matched) {
        const seenCount = seenIds.get(table.id) ?? 0;
        seenIds.set(table.id, seenCount + 1);
        if (seenCount > 0) {
          table.id = `${table.id}_dup${seenCount}`;
        }
      }

      return matched;
    }

    // Untagged PDFs have no struct tree to corroborate a layout candidate --
    // detectTabularContent's own heuristic is the only signal available, so
    // this is the one place isGenuinelyTabular actually filters anything.
    const genuinelyTabular = tables.filter(t => this.isGenuinelyTabular(t.cells, t.rowCount, t.columnCount));
    for (const table of genuinelyTabular) {
      this.validateTableAccessibility(table);
    }

    return genuinelyTabular;
  }

  private syncCellHeaderFlags(table: TableInfo): void {
    for (const cell of table.cells) {
      cell.isHeader = (table.hasHeaderRow && cell.row === 0) || (table.hasHeaderColumn && cell.column === 0);
    }
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

          table.cells = this.buildTableCells(
            block.lines,
            columnPositions,
            table.hasHeaderRow,
            table.hasHeaderColumn
          );

          // Every layout candidate is kept here, even a false-positive one --
          // see analyzeTables' own isGenuinelyTabular filtering (applied
          // only to the FINAL untagged-document result) for why this can't
          // filter before enhanceTablesFromTags's positional matching runs.
          tables.push(table);
        }
      }
    }

    return tables;
  }

  /**
   * Root-caused live on a real math-workbook-style document: detectColumnPositions
   * only requires TWO x-positions to each recur in >=50% of a block's lines --
   * satisfied trivially by ordinary body text, since the left margin alone is
   * one such position for any paragraph, and a second, rarer recurring
   * indent (a hanging continuation line, a bullet/number column, an inline
   * citation) is enough to trip columnPositions.length >= 2. This
   * misclassified chapter headings and numbered-problem instructions as
   * "tables" -- confirmed directly: 135 of 136 flagged tables had a
   * first-row cell count of 1 against a claimed columnCount of 2-5, with
   * row-0 text like "CHAPTER 1 Introduction: Preventing Exclusion..." and
   * "Read the problems carefully and solve as many as you can." -- prose,
   * not headers. The existing merge-safety gate (PR #529) already refuses
   * to auto-fix these (correctly), but the audit still COUNTED every one as
   * a real, open accessibility issue -- pure noise inflating the issue
   * count with nothing an operator could act on.
   *
   * First guard -- column POPULATION, not just position recurrence: real
   * tabular data has multiple columns each consistently populated across
   * rows (a name/age/city table has real text in every column, every row).
   * Misdetected prose funnels almost all of a line's text into whichever
   * detected column is nearest -- overwhelmingly one dominant column, with
   * the others populated by rare accidental spillover only. Requiring at
   * least MIN_TABULAR_COLUMNS columns to each appear in at least
   * MIN_COLUMN_POPULATION_FRACTION of rows catches exactly that signature
   * while still accepting a genuinely sparse real table (an occasional
   * blank "notes" column doesn't stop its OTHER columns from clearing the
   * bar).
   *
   * Second guard -- excludes list-marker columns from counting toward that
   * population bar. A bulleted/numbered list is a SEPARATE false-positive
   * class the population check alone doesn't catch: both its "marker"
   * column (bullet glyphs, item numbers) and its "text" column are
   * genuinely populated in nearly every row, since a marker and a line of
   * text both appear on every list item -- e.g. a real live sample: column
   * 0 = "•" in every single row, column 1 = the actual (long) item text. A
   * column is a marker column when EVERY one of its populated cells matches
   * LIST_MARKER_PATTERN (a real CodeRabbit review finding on this fix: an
   * earlier dominance-based version -- "does one value cover most of the
   * column?" -- both false-positived on a real, repeated categorical column
   * like Yes/Yes/No, hitting the dominance bar exactly at 2/2, and false-
   * negatived on a real ordered list like "1.", "2.", "3.", where no single
   * distinct value ever dominates at all. Matching marker SYNTAX instead of
   * relying on repetition gets both right).
   *
   * Only ever applied to the FINAL untagged-document result (see
   * analyzeTables) -- another real review finding: filtering inside
   * detectTabularContent, before enhanceTablesFromTags's positional
   * matching runs, doesn't remove the real /Table struct element a
   * rejected candidate would have paired with; it just leaves that element
   * to be force-paired with a different, unrelated candidate via
   * consumeNextTable's global-queue fallback. A confirmed structural match
   * is trusted unconditionally; this heuristic only ever prunes layout-only
   * detections where no struct tree exists to corroborate at all.
   *
   * Known, deliberately out-of-scope residual: a genuine Table of Contents
   * (chapter title | page number) is NOT caught by either guard -- both
   * columns are consistently populated, and page numbers are short but
   * highly varied text that never matches LIST_MARKER_PATTERN (no trailing
   * delimiter), so a TOC still measures as "genuinely tabular" here. Left
   * as a separate, not-yet-attempted follow-up (the codebase already has
   * TOC-page detection elsewhere, e.g. TocDetector, not currently wired
   * into table detection) rather than folded into this fix's
   * already-broader-than-planned scope.
   */
  private isGenuinelyTabular(cells: TableCell[], rowCount: number, columnCount: number): boolean {
    const textsByColumn: string[][] = Array.from({ length: columnCount }, () => []);
    for (const cell of cells) {
      const text = cell.text.trim();
      if (text.length > 0) {
        textsByColumn[cell.column].push(text);
      }
    }

    const isMarkerColumn = (texts: string[]): boolean => texts.every(text => LIST_MARKER_PATTERN.test(text));

    const columnsWithMeaningfulPopulation = textsByColumn.filter(
      texts => texts.length >= rowCount * MIN_COLUMN_POPULATION_FRACTION && !isMarkerColumn(texts)
    ).length;
    return columnsWithMeaningfulPopulation >= MIN_TABULAR_COLUMNS;
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

  private buildTableCells(
    lines: TextLine[],
    columnPositions: number[],
    hasHeaderRow: boolean,
    hasHeaderColumn: boolean
  ): TableCell[] {
    const cells: TableCell[] = [];

    lines.forEach((line, rowIndex) => {
      const rowText: string[][] = columnPositions.map(() => []);

      for (const item of line.items) {
        const roundedX = Math.round(item.position.x / 10) * 10;
        let columnIndex = 0;
        let closestDistance = Infinity;
        for (let i = 0; i < columnPositions.length; i++) {
          const distance = Math.abs(columnPositions[i] - roundedX);
          if (distance < closestDistance) {
            closestDistance = distance;
            columnIndex = i;
          }
        }
        rowText[columnIndex].push(item.text);
      }

      rowText.forEach((texts, columnIndex) => {
        if (texts.length === 0) return;
        cells.push({
          row: rowIndex,
          column: columnIndex,
          text: texts.join(' ').trim(),
          isHeader: (hasHeaderRow && rowIndex === 0) || (hasHeaderColumn && columnIndex === 0),
          rowSpan: 1,
          colSpan: 1,
        });
      });
    });

    return cells;
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
    // Counts /Table structure elements per page, in the same pre-order
    // document-tree walk that pdfModifierService.findStructureElementsByType
    // uses — so the stamped index reliably identifies "the Nth /Table
    // element on this page" for positional re-targeting at apply time.
    const perPageTableIndex = new Map<number, number>();

    try {
      const catalog = parsedPdf.pdfLibDoc.context.lookup(
        parsedPdf.pdfLibDoc.context.trailerInfo.Root
      );

      if (catalog instanceof PDFDict) {
        const structTreeRootRef = catalog.get(PDFName.of('StructTreeRoot'));
        if (structTreeRootRef) {
          const structTreeRoot = parsedPdf.pdfLibDoc.context.lookup(structTreeRootRef);
          if (structTreeRoot instanceof PDFDict) {
            // Seeded null, not 1: no real /Pg has been observed yet at the
            // tree root, and a fabricated "page 1" default is exactly the
            // bug resolveTablePageNumber's currentPage fallback exists to
            // avoid for /Table elements (see its doc comment).
            await this.findTaggedTables(structTreeRoot, parsedPdf.pdfLibDoc, pageMap, unmatchedTableQueues, globalQueue, perPageTableIndex, null);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to enhance tables from tags:', err instanceof Error ? err.message : 'Unknown error');
    }

    // perPageTableIndex now holds the FINAL count of /Table structure
    // elements resolved to each page (every element increments it, matched
    // or not) -- stamp each matched table with its real page's total so
    // downstream consumers can tell an unambiguous single-table page from a
    // genuinely multi-table one, notably for a pageReassigned table whose own
    // stale position can't be used for that (see TableInfo.tablesOnRealPage).
    for (const table of tables) {
      if (table.structureMatched) {
        table.tablesOnRealPage = perPageTableIndex.get(table.pageNumber) ?? 1;
      }
    }
  }

  private async findTaggedTables(
    node: PDFDict,
    pdfDoc: PDFDocument,
    pageMap: Map<string, number>,
    unmatchedTableQueues: Map<number, TableInfo[]>,
    globalQueue: TableInfo[],
    perPageTableIndex: Map<number, number>,
    currentPage: number | null
  ): Promise<void> {
    try {
      const typeRef = node.get(PDFName.of('S'));
      const type = typeRef?.toString();
      // Resolved once per node and threaded to children below (mirroring
      // traverseStructureTree's heading walk), so a node without its own
      // /Pg at least inherits whatever page an ancestor resolved. That's not
      // enough for /Table specifically: Seam C's tagging puts /Pg on neither
      // the /Table node nor any ancestor up to /Document -- only on leaf row/
      // cell descendants (e.g. the first /TH) -- so /Table needs its own
      // subtree search instead of (or in addition to) ancestor inheritance.
      // Non-table nodes also stay null-tolerant here (resolvePageNumber never
      // coerces to a default) so a genuinely /Pg-less ancestor chain (e.g.
      // /Document, /StructTreeRoot with no /Pg of their own) threads "not yet
      // known" all the way down to a nested /Table, rather than silently
      // resolving to a fabricated page one level up and re-poisoning
      // resolveTablePageNumber's own null result for every /Table beneath it.
      const pageNumber = type === '/Table'
        ? this.resolveTablePageNumber(node, pdfDoc, pageMap, currentPage)
        : this.resolvePageNumber(node, pdfDoc, currentPage, pageMap);

      if (type === '/Table') {
        if (pageNumber === null) {
          console.warn('Skipping /Table struct element with no resolvable page (no /Pg on itself, its subtree, or any ancestor) -- leaving it unmatched rather than defaulting to a fabricated page.');
        } else {
          // Stamp the index before consuming — every /Table element on the
          // page counts, matched or not, to mirror findStructureElementsByType.
          const elementIndex = perPageTableIndex.get(pageNumber) ?? 0;
          perPageTableIndex.set(pageNumber, elementIndex + 1);

          const matchingTable = this.consumeNextTable(pageNumber, unmatchedTableQueues, globalQueue);

          if (matchingTable) {
            matchingTable.structureElementIndex = elementIndex;

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
      }

      const kids = node.get(PDFName.of('K'));
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i++) {
          const kid = kids.get(i);
          if (kid instanceof PDFDict) {
            await this.findTaggedTables(kid, pdfDoc, pageMap, unmatchedTableQueues, globalQueue, perPageTableIndex, pageNumber);
          } else {
            const resolved = pdfDoc.context.lookup(kid);
            if (resolved instanceof PDFDict) {
              await this.findTaggedTables(resolved, pdfDoc, pageMap, unmatchedTableQueues, globalQueue, perPageTableIndex, pageNumber);
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
      table.structureMatched = true;
      return table;
    }

    if (globalQueue.length > 0) {
      const table = globalQueue.shift()!;
      // Remove it from its own (stale) per-page queue BEFORE reassigning
      // pageNumber below -- this lookup must use the table's original page.
      const tablePageQueue = unmatchedTableQueues.get(table.pageNumber);
      if (tablePageQueue) {
        const pageIndex = tablePageQueue.indexOf(table);
        if (pageIndex !== -1) {
          tablePageQueue.splice(pageIndex, 1);
        }
      }
      // This table's own layout-detected page had no more unmatched
      // candidates, so it's being paired with a /Table element that actually
      // lives on `pageNumber` -- a different page (the well-known "row(s)
      // straddle a page boundary" case). Re-home it to the element's real
      // page: `structureElementIndex` (stamped by the caller right after this
      // returns) is computed relative to `pageNumber`, not table.pageNumber,
      // so leaving the stale value here would make `table.id` encode a
      // (page, index) pair that no real struct element ever occupies --
      // permanently unfindable by findTargetTable, and wrong in every
      // page-referencing message pdf-table.validator.ts emits for this table
      // (location strings, issue.pageNumber, pageDims lookups). Cell content
      // (rowCount/columnCount/cells) still reflects the original page's
      // text-layout, not pageNumber's -- fine for table-header-fix's
      // mechanical TD->TH promotion, but a known residual gap for anything
      // that reads cell text (e.g. table-summary's AI-drafted guidance).
      table.pageNumber = pageNumber;
      table.pageReassigned = true;
      table.structureMatched = true;
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
            } else if (type === '/TBody') {
              // Recurse into TBody to find TR children
              await this.checkTableHeaders(resolved, pdfDoc, table);
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
    const LINK_BATCH_SIZE = 10;
    const nonDescriptivePattern = /^(click|here|link|more|read|download|learn|info)$/i;
    const nonDescriptivePhrases = /^(click here|read more|learn more|more info|download here)$/i;
    const shortAcronymPattern = /^[A-Z0-9]{2,5}$/;
    const whitelist = ['FAQ', 'PDF', 'API', 'URL', 'RSS', 'XML', 'CSV', 'HOME', 'HELP'];

    const allPageLinks: LinkInfo[][] = [];

    for (let i = 1; i <= parsedPdf.structure.pageCount; i += LINK_BATCH_SIZE) {
      const batchEnd = Math.min(i + LINK_BATCH_SIZE - 1, parsedPdf.structure.pageCount);
      const batchNums = Array.from({ length: batchEnd - i + 1 }, (_, k) => i + k);

      const batchResults = await Promise.all(
        batchNums.map(async (pageNum) => {
          const pageLinks: LinkInfo[] = [];
          try {
            const page = await parsedPdf.pdfjsDoc.getPage(pageNum);
            const annotations = await page.getAnnotations();
            const viewport = page.getViewport({ scale: 1 });

            let annotIndex = 0;
            for (const annot of annotations) {
              if (annot.subtype === 'Link') {
                const rect = annot.rect || [0, 0, 0, 0];
                const link: LinkInfo = {
                  id: `link_p${pageNum}_${annotIndex}`,
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
                const isNonDescriptive = nonDescriptivePattern.test(text) || nonDescriptivePhrases.test(text);
                const isWhitelisted = whitelist.includes(text.toUpperCase());
                const isValidAcronym = shortAcronymPattern.test(text) && text === text.toUpperCase();

                if (text && !isNonDescriptive && (text.length > 3 || isWhitelisted || isValidAcronym)) {
                  link.hasDescriptiveText = true;
                } else {
                  link.issues.push('Link text is not descriptive (WCAG 2.4.4)');
                }

                pageLinks.push(link);
                annotIndex++;
              }
            }
          } catch (err) {
            console.warn(`Failed to extract links from page ${pageNum}:`, err instanceof Error ? err.message : 'Unknown error');
          }
          return pageLinks;
        })
      );

      allPageLinks.push(...batchResults);
    }

    return allPageLinks.flat();
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
