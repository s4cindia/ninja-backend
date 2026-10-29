/**
 * PDF Table-Cell/Row Tree-Reachability Validator
 *
 * Same disconnection SHAPE as pdf-figure-caption-tree.validator.ts's /fc
 * caption case and pdf-inline-figure-tree.validator.ts's inline /Figure
 * case, this time for table structure (/TD, /TH, /TR): a real PDF object,
 * correctly tagged in the content stream, but never linked into any
 * parent's /K array, so a top-down walk from /StructTreeRoot -- the way a
 * screen reader or a compliance checker actually reads a tagged PDF --
 * never encounters it at all.
 *
 * Confirmed real via direct struct-tree inspection of
 * Farrar_2E_Comp_188910.pdf's remediated output: 5 disconnected /TD
 * elements across 5 different pages/tables, inherited untouched from the
 * document's original (InDesign) producer alongside this same document's
 * Matterhorn 01-004 nesting defect (see pdf-structure.validator.ts's
 * validateTaggedContentInsideArtifact).
 *
 * Distinct from pdf-table-header-scope.validator.ts (which walks an
 * already-fully-connected real table top-down to check /Scope attributes)
 * -- this only ever looks at forward-reachability, nothing about
 * Scope/Headers attributes.
 *
 * /TR detection is a SEPARATE pass from /TD /TH detection, not a variant
 * of the same one, because a /TR has no own MCID: unlike a /TD/TH, which
 * is cross-referenced in /StructTreeRoot's own /ParentTree (a bottom-up
 * MCID -> StructElem lookup) regardless of its top-down reachability, a
 * disconnected /TR is invisible to that same reverse index and can only
 * be found by enumerating every indirect object in the file and checking
 * each real /TR StructElem against the (same) top-down reachable set.
 * Confirmed real on the same Farrar document: exactly 5 orphaned /TR
 * elements, one per orphaned /TD's own row (raw-object-scan confirmed,
 * not a ParentTree walk).
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface TableCellTreeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalCells: number;
    disconnectedCells: number;
    totalRows: number;
    disconnectedRows: number;
  };
}

/**
 * Finds the first (page, MCID) pair reachable from a struct element's own
 * /K subtree -- used to derive a disconnected /TR's own page/position
 * identity from its TD/TH children, since the /TR itself carries neither
 * /Pg nor an own MCID in the confirmed-real document shape. Returns null
 * if no content-bearing descendant can be found (nothing to build a
 * re-locatable element id from).
 */
function firstPageAndMcid(
  doc: ParsedPDF['pdfLibDoc'],
  node: unknown,
  pageByRef: Map<string, number>,
  depth = 0,
): { page: number; mcid: number } | null {
  if (depth > 10) return null;
  const resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;
  if (resolved instanceof PDFArray) {
    for (const item of resolved.asArray()) {
      const found = firstPageAndMcid(doc, item, pageByRef, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!(resolved instanceof PDFDict)) return null;
  const pgRaw = resolved.get(PDFName.of('Pg'));
  const page = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) : undefined;
  const kRaw = resolved.get(PDFName.of('K'));
  const mcids: number[] = [];
  const collectMcids = (n: unknown): void => {
    const r = n instanceof PDFRef ? doc.context.lookup(n) : n;
    if (r instanceof PDFNumber) { mcids.push(r.asNumber()); return; }
    if (r instanceof PDFArray) { for (const item of r.asArray()) collectMcids(item); }
  };
  if (kRaw !== undefined) collectMcids(kRaw);
  if (page !== undefined && mcids.length > 0) return { page, mcid: Math.min(...mcids) };
  if (kRaw !== undefined) {
    const found = firstPageAndMcid(doc, kRaw, pageByRef, depth + 1);
    if (found) return found;
  }
  return null;
}

class PdfTableCellTreeValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<TableCellTreeValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issues: [], metadata: { totalCells: 0, disconnectedCells: 0, totalRows: 0, disconnectedRows: 0 } };
    }

    const pageByRef = new Map<string, number>();
    doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

    // Top-down: every StructElem ref actually reachable from the root --
    // the same traversal a screen reader/compliance checker uses.
    const reachable = new Set<string>();
    const seenTD = new Set<string>();
    const visitTopDown = (nodeRef: unknown): void => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seenTD.has(key)) return;
        seenTD.add(key);
        reachable.add(key);
      }
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
      if (node instanceof PDFArray) {
        for (const item of node.asArray()) visitTopDown(item);
        return;
      }
      if (!(node instanceof PDFDict)) return;
      const k = node.get(PDFName.of('K'));
      if (k !== undefined) visitTopDown(k);
    };
    visitTopDown(structRoot.get(PDFName.of('K')));

    // Bottom-up: every real /TD or /TH StructElem, found by walking the
    // (possibly hierarchical -- a /Kids number tree, not just a flat
    // /Nums array) /ParentTree. This finds a disconnected cell regardless
    // of reachability, since /ParentTree is a separate reverse index the
    // top-down walk above never touches.
    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    if (!(parentTreeDict instanceof PDFDict)) {
      return { issues: [], metadata: { totalCells: 0, disconnectedCells: 0, totalRows: 0, disconnectedRows: 0 } };
    }

    const seenCells = new Set<string>();
    let totalCells = 0;
    const issues: AuditIssue[] = [];

    const walkNumsTree = (node: PDFDict): void => {
      const numsRaw = node.get(PDFName.of('Nums'));
      if (numsRaw) {
        const numsArr = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
        if (!(numsArr instanceof PDFArray)) return;
        const raw = numsArr.asArray();
        for (let i = 1; i < raw.length; i += 2) {
          const valRaw = raw[i];
          const val = valRaw instanceof PDFRef ? doc.context.lookup(valRaw) : valRaw;
          if (!(val instanceof PDFArray)) continue;
          for (const entry of val.asArray()) {
            if (!(entry instanceof PDFRef)) continue;
            const key = entry.toString();
            if (seenCells.has(key)) continue;
            const resolved = doc.context.lookup(entry);
            if (!(resolved instanceof PDFDict)) continue;
            const rawS = resolved.get(PDFName.of('S'))?.toString().replace(/^\//, '');
            if (rawS !== 'TD' && rawS !== 'TH') continue;
            seenCells.add(key);
            totalCells++;
            if (reachable.has(key)) continue; // correctly connected -- nothing to report

            const pgRaw = resolved.get(PDFName.of('Pg'));
            const page = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) : undefined;
            const kRaw = resolved.get(PDFName.of('K'));
            const mcids: number[] = [];
            if (kRaw instanceof PDFArray) {
              for (const item of kRaw.asArray()) if (item instanceof PDFNumber) mcids.push(item.asNumber());
            } else if (kRaw instanceof PDFNumber) {
              mcids.push(kRaw.asNumber());
            }
            // No resolvable page/MCID means no way to build a re-locatable
            // element id for the writer to act on later -- skip rather
            // than emit an issue nothing can ever fix.
            if (page === undefined || mcids.length === 0) continue;

            const minMcid = Math.min(...mcids);
            const element = `tablecell_p${page}_mc${minMcid}`;
            issues.push({
              id: `pdf-table-cell-tree-${++this.issueCounter}`,
              source: 'pdf-table-cell-tree',
              severity: 'serious',
              code: 'TABLE-CELL-DISCONNECTED',
              message: `Table cell "${element}" (/${rawS}) on page ${page} is tagged in the content stream and cross-referenced in the ParentTree, but is not reachable from the structure tree root -- invisible to assistive technology and compliance checkers that read the document top-down`,
              wcagCriteria: ['1.3.1'],
              location: `Page ${page}`,
              suggestion: 'Reattach the table cell into its row\'s (/TR) /K array, in correct column order.',
              category: 'structure',
              element,
              pageNumber: page,
              matterhornCheckpoint: '01-005',
              matterhornHow: 'M',
            });
          }
        }
        return;
      }
      const kidsRaw = node.get(PDFName.of('Kids'));
      if (!kidsRaw) return;
      const kids = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
      if (!(kids instanceof PDFArray)) return;
      for (const kidRef of kids.asArray()) {
        const kid = kidRef instanceof PDFRef ? doc.context.lookup(kidRef) : kidRef;
        if (kid instanceof PDFDict) walkNumsTree(kid);
      }
    };
    walkNumsTree(parentTreeDict);
    const disconnectedCells = issues.length;

    // /TR pass: NOT a ParentTree walk (a /TR has no own MCID to be
    // cross-referenced by) -- enumerate every real /TR StructElem in the
    // file directly and check each against the SAME top-down `reachable`
    // set built above. See this file's own header comment for why this
    // has to be a separate detection technique from /TD /TH above.
    let totalRows = 0;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (obj.get(PDFName.of('Type'))?.toString() !== '/StructElem') continue;
      if (obj.get(PDFName.of('S'))?.toString().replace(/^\//, '') !== 'TR') continue;
      totalRows++;
      const key = ref.toString();
      if (reachable.has(key)) continue; // correctly connected -- nothing to report

      const located = firstPageAndMcid(doc, obj.get(PDFName.of('K')), pageByRef);
      // No resolvable page/MCID (derived from this row's own TD/TH
      // children) means no way to build a re-locatable element id for the
      // writer to act on later -- skip rather than emit an issue nothing
      // can ever fix, same convention as the /TD /TH pass above.
      if (!located) continue;

      const element = `tablerow_p${located.page}_mc${located.mcid}`;
      issues.push({
        id: `pdf-table-cell-tree-${++this.issueCounter}`,
        source: 'pdf-table-cell-tree',
        severity: 'serious',
        code: 'TABLE-ROW-DISCONNECTED',
        message: `Table row "${element}" (/TR) on page ${located.page} is tagged in the content stream, but is not reachable from the structure tree root -- invisible to assistive technology and compliance checkers that read the document top-down`,
        wcagCriteria: ['1.3.1'],
        location: `Page ${located.page}`,
        suggestion: 'Reattach the table row into its containing table\'s /K array, in correct row order.',
        category: 'structure',
        element,
        pageNumber: located.page,
        matterhornCheckpoint: '01-005',
        matterhornHow: 'M',
      });
    }
    const disconnectedRows = issues.length - disconnectedCells;

    logger.info(
      `[PdfTableCellTreeValidator] ${totalCells} table cell(s) (${disconnectedCells} disconnected), ` +
      `${totalRows} table row(s) (${disconnectedRows} disconnected) found`,
    );

    return {
      issues,
      metadata: { totalCells, disconnectedCells, totalRows, disconnectedRows },
    };
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
    return resolved instanceof PDFDict ? resolved : undefined;
  }
}

export const pdfTableCellTreeValidator = new PdfTableCellTreeValidator();
