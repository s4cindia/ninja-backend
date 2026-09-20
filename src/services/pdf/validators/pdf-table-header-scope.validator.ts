/**
 * PDF Table Header Scope Validator
 *
 * Matterhorn 15-003 ("In a table not organized with Headers attributes and
 * IDs, a TH cell does not contain a Scope attribute", UA1:7.5-2, machine-
 * testable). Confirmed live via the real PAC/axesPAC desktop tool on a real
 * 377-page document (Math_Weir_PDF): "Table header cell has no associated
 * subcells" — 708 failed, 0 passed. Direct struct-tree inspection of the
 * same document confirmed an EXACT match: all 105 /Table elements have TH
 * cells (already correctly tagged — no promotion needed), and every one of
 * their 708 TH cells has zero /Scope attribute at all.
 *
 * This is a genuinely different gap from MATTERHORN-15-001/15-002 (a row or
 * column of header DATA exists but isn't tagged as TH at all —
 * pdf-structure-writer.service.ts's fixSimpleTableHeaders/
 * fixSimpleTableColumnHeaders already handle that, including writing
 * /Scope as part of the promotion). Those writers only ever run in
 * response to a detected "not tagged as TH" issue — a table whose header
 * row/column is ALREADY tagged TH (by the document's own original
 * producer, or an earlier remediation round, as is the case for all 105 of
 * Math_Weir_PDF.pdf's real tables) never trips that detector at all, so
 * its missing-/Scope gap is never found or fixed. This validator exists
 * specifically to close that gap: it never promotes a TD to TH, only finds
 * an EXISTING TH with no /Scope.
 *
 * One issue per table (not per cell) — a table can have many TH cells all
 * missing /Scope at once (Math_Weir_PDF.pdf's tables average ~6.7 TH cells
 * each), and pdf-structure-writer.service.ts's fixTableHeaderScope fixes
 * every one of a table's missing-scope cells in a single call.
 */

import { PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface TableHeaderScopeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalTables: number;
    tablesWithMissingScope: number;
    totalThCells: number;
    thCellsMissingScope: number;
  };
}

class PdfTableHeaderScopeValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<TableHeaderScopeValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const issues: AuditIssue[] = [];
    let totalTables = 0;
    let totalThCells = 0;
    let thCellsMissingScope = 0;

    const root = this.getStructTreeRoot(doc);
    if (!root) {
      return { issues, metadata: { totalTables: 0, tablesWithMissingScope: 0, totalThCells: 0, thCellsMissingScope: 0 } };
    }

    const perPageTableIndex = new Map<number, number>();
    const seen = new Set<string>();

    const visit = (nodeRef: unknown, inheritedPage: number | undefined): void => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;

      if (node instanceof PDFArray) {
        for (const item of node.asArray()) visit(item, inheritedPage);
        return;
      }
      if (!(node instanceof PDFDict)) return;

      const isTable = node.get(PDFName.of('S'))?.toString() === '/Table';
      const directPage = this.resolvePageNumber(doc, node.get(PDFName.of('Pg')));
      // /Table specifically needs a subtree search before falling back to
      // ancestor inheritance: some real documents put /Pg on neither the
      // /Table node nor any ancestor up to /Document, only on leaf row/cell
      // descendants (the same gap resolveTablePageNumber/findPageNumberInSubtree
      // in structure-analyzer.service.ts already exists to close, and
      // findTargetTable's own resolveElementPageRef relies on for the exact
      // same reason). Every other node keeps the simpler own-/Pg-else-
      // inherited resolution.
      const subtreePage = directPage === undefined && isTable
        ? this.resolvePageNumber(doc, this.findPageRefInSubtree(doc, node))
        : undefined;
      const ownPage = directPage ?? subtreePage ?? inheritedPage;

      if (isTable) {
        if (ownPage === undefined) {
          logger.warn('[PdfTableHeaderScopeValidator] Skipping /Table struct element with no resolvable page (no /Pg on itself, its subtree, or any ancestor) -- leaving it unmatched rather than defaulting to a fabricated page.');
        } else {
          totalTables++;
          const pageNumber = ownPage;
          const tableIndex = perPageTableIndex.get(pageNumber) ?? 0;
          perPageTableIndex.set(pageNumber, tableIndex + 1);

          const missing = this.findThCellsMissingScope(doc, node);
          totalThCells += missing.total;
          thCellsMissingScope += missing.missing;
          if (missing.missing > 0) {
            issues.push(this.buildIssue(pageNumber, tableIndex, missing.missing));
          }
        }
      }

      const k = node.get(PDFName.of('K'));
      if (k !== undefined) visit(k, ownPage);
    };

    visit(root, undefined);

    logger.info(
      `[PdfTableHeaderScopeValidator] ${totalTables} table(s), ${totalThCells} TH cell(s): ` +
      `${thCellsMissingScope} missing /Scope across ${issues.length} table(s)`,
    );

    return {
      issues,
      metadata: {
        totalTables,
        tablesWithMissingScope: issues.length,
        totalThCells,
        thCellsMissingScope,
      },
    };
  }

  /**
   * Walks a table's rows (including THead/TBody/TFoot) and counts /TH
   * cells with and without a /Scope attribute. Does not distinguish row-0
   * vs column-0 headers here — that positional classification is the
   * writer's job at fix time; detection only needs to know whether
   * anything is missing at all.
   */
  private findThCellsMissingScope(doc: ParsedPDF['pdfLibDoc'], table: PDFDict): { total: number; missing: number } {
    let total = 0;
    let missing = 0;
    const seen = new Set<string>();

    const visitRow = (rowRef: unknown): void => {
      if (rowRef instanceof PDFRef) {
        const key = rowRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }
      const row = rowRef instanceof PDFRef ? doc.context.lookup(rowRef) : rowRef;
      if (!(row instanceof PDFDict)) return;
      const tag = row.get(PDFName.of('S'))?.toString().replace(/^\//, '');

      if (tag === 'THead' || tag === 'TBody' || tag === 'TFoot') {
        const k = row.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
        for (const kid of kids) visitRow(kid);
        return;
      }
      if (tag !== 'TR') return;

      const k = row.get(PDFName.of('K'));
      const cellRefs = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
      for (const cellRef of cellRefs) {
        const cell = cellRef instanceof PDFRef ? doc.context.lookup(cellRef) : cellRef;
        if (!(cell instanceof PDFDict)) continue;
        if (cell.get(PDFName.of('S'))?.toString().replace(/^\//, '') !== 'TH') continue;
        total++;
        if (!this.hasScopeAttribute(doc, cell)) missing++;
      }
    };

    const k = table.get(PDFName.of('K'));
    const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
    for (const kid of kids) visitRow(kid);

    return { total, missing };
  }

  /** True if the element's /A (attributes) already carries a Table-owner dict with a /Scope entry. */
  private hasScopeAttribute(doc: ParsedPDF['pdfLibDoc'], elem: PDFDict): boolean {
    const aRaw = elem.get(PDFName.of('A'));
    const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
    const check = (d: unknown): boolean => d instanceof PDFDict && d.get(PDFName.of('Scope')) !== undefined;
    if (check(a)) return true;
    if (a instanceof PDFArray) {
      for (const item of a.asArray()) {
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (check(resolved)) return true;
      }
    }
    return false;
  }

  private buildIssue(pageNumber: number, tableIndex: number, missingCount: number): AuditIssue {
    // Includes the element id in the message itself -- two distinct tables
    // on the same page can otherwise carry an identical page+message pair
    // (same missingCount, e.g. two 2-TH tables), which would silently
    // collapse to one under base-audit.service.ts's deduplicateIssues (keys
    // on source+code+checkpoint+page+location+boundingBox+message). Same
    // fix pattern as the Figure struct-tree validator's own dedup fix
    // (PR #581).
    const elementId = `table_p${pageNumber}_${tableIndex}`;
    return {
      id: `pdf-table-header-scope-${++this.issueCounter}`,
      source: 'pdf-table-header-scope',
      severity: 'serious',
      code: 'TABLE-HEADER-MISSING-SCOPE',
      message: `Table ${elementId} on page ${pageNumber} has ${missingCount} header cell(s) with no /Scope attribute`,
      wcagCriteria: ['1.3.1'],
      location: `Page ${pageNumber}`,
      suggestion: 'Add a Scope attribute (Row, Column, or Both) to each table header cell so assistive technology can associate it with its data cells.',
      category: 'table',
      element: elementId,
      pageNumber,
      matterhornCheckpoint: '15-003',
      matterhornHow: 'M',
    };
  }

  /**
   * Shallowest /Pg found among this node's own children (level-by-level,
   * not depth-first) -- mirrors pdf-structure-writer.service.ts's own
   * resolveElementPageRef exactly, so a /Table's page assignment here
   * agrees with what fixTableHeaderScope's own findTargetTable will later
   * resolve for the same element. Checks every direct child for its own
   * /Pg first, and only recurses deeper if none of them have one.
   */
  private findPageRefInSubtree(doc: ParsedPDF['pdfLibDoc'], node: PDFDict, maxDepth = 6): PDFRef | undefined {
    if (maxDepth <= 0) return undefined;

    const k = node.get(PDFName.of('K'));
    const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
    const children: PDFDict[] = [];
    for (const kid of kids) {
      const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
      if (resolved instanceof PDFDict) children.push(resolved);
    }

    for (const child of children) {
      const pg = child.get(PDFName.of('Pg'));
      if (pg instanceof PDFRef) return pg;
    }
    for (const child of children) {
      const nested = this.findPageRefInSubtree(doc, child, maxDepth - 1);
      if (nested) return nested;
    }
    return undefined;
  }

  private resolvePageNumber(doc: ParsedPDF['pdfLibDoc'], pgEntry: unknown): number | undefined {
    if (!(pgEntry instanceof PDFRef)) return undefined;
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].ref.toString() === pgEntry.toString()) return i + 1;
    }
    return undefined;
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const ref = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const root = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    return root instanceof PDFDict ? root : undefined;
  }
}

export const pdfTableHeaderScopeValidator = new PdfTableHeaderScopeValidator();
