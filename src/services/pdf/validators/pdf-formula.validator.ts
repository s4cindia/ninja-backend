/**
 * PDF Formula Validator
 *
 * Walks the tagged structure tree for /Formula elements that lack a text
 * alternative (/ActualText or /Alt). A Formula without an alternate reading is
 * announced by screen readers as its raw glyphs (e.g. "E mc 2"), which is
 * meaningless — PDF/UA (veraPDF clause 7.7) and WCAG 1.1.1 require one.
 *
 * Emits an MCID-exact element id ("formula_p{page}_mc{mcid}") that
 * pdfModifierService.setActualText can target precisely, plus the region's
 * bounding box (from the /A /Layout /BBox that Seam C stamps on each Formula)
 * so a downstream step can crop the formula and draft ActualText with AI.
 *
 * Detection only — no AI, no rendering. Drafting/applying happens later in the
 * AI-analysis dispatch and the apply controller.
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface FormulaValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalFormulas: number;
    formulasWithAlternate: number;
    formulasMissingAlternate: number;
  };
}

interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

class PdfFormulaValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<FormulaValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const issues: AuditIssue[] = [];
    let totalFormulas = 0;
    let withAlternate = 0;

    const root = this.getStructTreeRoot(doc);
    if (!root) {
      return { issues, metadata: { totalFormulas: 0, formulasWithAlternate: 0, formulasMissingAlternate: 0 } };
    }

    // page ref → {pageNumber, width, height} (device-space heights match the /A /BBox convention)
    const pageByRef = new Map<string, PageInfo>();
    doc.getPages().forEach((page, i) => {
      const { width, height } = page.getSize();
      pageByRef.set(page.ref.toString(), { pageNumber: i + 1, width, height });
    });

    // positional index of formulas per page (fallback id when no MCID)
    const perPageIndex = new Map<number, number>();
    const seen = new Set<string>();

    const visit = (nodeRef: unknown): void => {
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
      if (!(node instanceof PDFDict)) return;
      // guard against cycles / shared refs
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }

      if (node.get(PDFName.of('S'))?.toString() === '/Formula') {
        totalFormulas++;
        if (this.hasAlternate(node)) {
          withAlternate++;
        } else {
          issues.push(this.buildIssue(node, pageByRef, perPageIndex, doc));
        }
      }

      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
      for (const kid of kids) if (kid instanceof PDFRef || kid instanceof PDFDict) visit(kid);
    };

    visit(root);

    logger.info(
      `[PdfFormulaValidator] ${totalFormulas} formula(s): ${withAlternate} with alternate, ${issues.length} missing`,
    );

    return {
      issues,
      metadata: {
        totalFormulas,
        formulasWithAlternate: withAlternate,
        formulasMissingAlternate: issues.length,
      },
    };
  }

  private hasAlternate(elem: PDFDict): boolean {
    for (const key of ['ActualText', 'Alt'] as const) {
      const v = elem.get(PDFName.of(key));
      if (v instanceof PDFString && v.decodeText().trim().length > 0) return true;
    }
    return false;
  }

  private buildIssue(
    elem: PDFDict,
    pageByRef: Map<string, PageInfo>,
    perPageIndex: Map<number, number>,
    doc: ParsedPDF['pdfLibDoc'],
  ): AuditIssue {
    const pgRef = elem.get(PDFName.of('Pg'));
    const pageInfo = pgRef instanceof PDFRef ? pageByRef.get(pgRef.toString()) : undefined;
    const pageNumber = pageInfo?.pageNumber ?? 1;

    const positional = perPageIndex.get(pageNumber) ?? 0;
    perPageIndex.set(pageNumber, positional + 1);

    const mcid = this.firstMcid(elem, doc);
    const element = mcid !== undefined ? `formula_p${pageNumber}_mc${mcid}` : `formula_p${pageNumber}_${positional}`;
    const boundingBox = pageInfo ? this.regionBBox(elem, pageInfo, doc) : undefined;

    return {
      id: `pdf-formula-${++this.issueCounter}`,
      source: 'pdf-formula',
      severity: 'serious',
      code: 'FORMULA-MISSING-ACTUALTEXT',
      message: `Formula on page ${pageNumber} has no text alternative (ActualText)`,
      wcagCriteria: ['1.1.1'],
      location: `Page ${pageNumber}`,
      suggestion:
        'Provide an ActualText reading for the formula (e.g. a spoken-math or LaTeX-derived description). AI can draft this from the formula region.',
      category: 'formula',
      element,
      pageNumber,
      // veraPDF flags this under ISO 14289-1 clause 7.7 (non-text objects).
      matterhornHow: 'M',
      boundingBox,
    };
  }

  /** First MCID referenced by the element's /K (single number or first number in an array). */
  private firstMcid(elem: PDFDict, doc: ParsedPDF['pdfLibDoc']): number | undefined {
    const k = elem.get(PDFName.of('K'));
    if (k instanceof PDFNumber) return k.asNumber();
    if (k instanceof PDFArray) {
      for (const item of k.asArray()) {
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (resolved instanceof PDFNumber) return resolved.asNumber();
      }
    }
    return undefined;
  }

  /**
   * Convert the element's /A /Layout /BBox (device space, bottom-left) into the
   * top-left PDF-point boundingBox convention that validators emit.
   */
  private regionBBox(
    elem: PDFDict,
    pageInfo: PageInfo,
    doc: ParsedPDF['pdfLibDoc'],
  ): AuditIssue['boundingBox'] {
    const aRaw = elem.get(PDFName.of('A'));
    const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
    const layoutDict = this.layoutAttr(a, doc);
    if (!layoutDict) return undefined;

    const bb = layoutDict.get(PDFName.of('BBox'));
    if (!(bb instanceof PDFArray) || bb.size() !== 4) return undefined;
    const nums = bb.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : Number(n?.toString())));
    if (nums.some((n) => Number.isNaN(n))) return undefined;

    const [x1, y1, x2, y2] = nums;
    return {
      x: x1,
      y: pageInfo.height - y2, // device bottom-left → top-left origin
      width: x2 - x1,
      height: y2 - y1,
      pageWidth: pageInfo.width,
      pageHeight: pageInfo.height,
    };
  }

  /** /A may be a single attribute dict or an array of them; find the /Layout owner. */
  private layoutAttr(a: unknown, doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    if (a instanceof PDFDict) return a;
    if (a instanceof PDFArray) {
      for (const item of a.asArray()) {
        const d = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (d instanceof PDFDict && d.get(PDFName.of('O'))?.toString() === '/Layout') return d;
      }
    }
    return undefined;
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const ref = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const root = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    return root instanceof PDFDict ? root : undefined;
  }
}

export const pdfFormulaValidator = new PdfFormulaValidator();
