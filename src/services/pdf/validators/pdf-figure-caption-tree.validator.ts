/**
 * PDF Figure-Caption Tree-Reachability Validator
 *
 * Confirmed real and live on Math_Weir_PDF.pdf via a fresh PAC/axesPAC
 * report the user shared (page 40's "Text object not tagged" findings, all
 * pointing at fragments of the two figure captions on that page): 75 real
 * /fc ("figure caption," an InDesign paragraph style, role-mapped to /P)
 * struct elements exist in the document, and 66 of them (88%) are
 * DISCONNECTED from the structure tree -- real PDF objects, correctly
 * MCID-tagged in the content stream, and correctly cross-referenced in
 * /StructTreeRoot's own /ParentTree (a bottom-up MCID -> StructElem lookup),
 * but never linked into any parent's /K array, so a top-down walk from
 * /StructTreeRoot -- the way a screen reader or a compliance checker
 * actually reads a tagged PDF -- never encounters them at all. This is
 * exactly why earlier structural checks in this codebase (an "any content
 * outside marked content" scan, a ParentTree-backing check) found nothing:
 * both only test whether a REVERSE (MCID -> StructElem) lookup resolves,
 * never whether the element is FORWARD-reachable from the root.
 *
 * Root cause traced precisely: every affected /fc's own /P correctly points
 * at its own /Story wrapper (an InDesign per-caption text-flow container),
 * and that /Story -> /fc link is intact. The break is one level up: the
 * /Story itself has no /P at all and isn't referenced by any other
 * element's /K -- confirmed identical across all 66 real cases, always
 * immediately following a /Figure (in MCID order) whose own direct parent
 * is a single-child /Sect wrapper with a real /P pointing at a genuine
 * multi-child container (the natural, correct reattachment point -- see
 * pdf-structure-writer.service.ts's reattachFigureCaption for the fix).
 *
 * Distinct from pdf-figure-structtree.validator.ts (which checks a
 * /Figure's own /Alt/ActualText) and pdf-structure.validator.ts's untagged-
 * content check (which only looks at PATH content never wrapped in any
 * marked-content tag at all, a completely different failure shape from a
 * genuinely-tagged-but-tree-disconnected caption).
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface FigureCaptionTreeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalCaptions: number;
    disconnectedCaptions: number;
  };
}

class PdfFigureCaptionTreeValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<FigureCaptionTreeValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issues: [], metadata: { totalCaptions: 0, disconnectedCaptions: 0 } };
    }

    const pageByRef = new Map<string, number>();
    doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

    // Top-down: every StructElem ref actually reachable from the root --
    // the same traversal a screen reader/compliance checker uses.
    const reachable = new Set<string>();
    const seen = new Set<string>();
    const visitTopDown = (nodeRef: unknown): void => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
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

    // Bottom-up: every real /fc StructElem, found by walking the
    // (possibly hierarchical -- a /Kids number tree, not just a flat
    // /Nums array; confirmed real on this same document) /ParentTree.
    // This finds a disconnected /fc regardless of reachability, since
    // /ParentTree is a separate reverse index the top-down walk above
    // never touches.
    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    if (!(parentTreeDict instanceof PDFDict)) {
      return { issues: [], metadata: { totalCaptions: 0, disconnectedCaptions: 0 } };
    }

    const seenFc = new Set<string>();
    let totalCaptions = 0;
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
            if (seenFc.has(key)) continue;
            const resolved = doc.context.lookup(entry);
            if (!(resolved instanceof PDFDict)) continue;
            const rawS = resolved.get(PDFName.of('S'))?.toString().replace(/^\//, '');
            if (rawS !== 'fc') continue;
            seenFc.add(key);
            totalCaptions++;
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
            const element = `caption_p${page}_mc${minMcid}`;
            issues.push({
              id: `pdf-figure-caption-tree-${++this.issueCounter}`,
              source: 'pdf-figure-caption-tree',
              severity: 'serious',
              code: 'FIGURE-CAPTION-DISCONNECTED',
              message: `Figure caption "${element}" on page ${page} is tagged in the content stream and cross-referenced in the ParentTree, but is not reachable from the structure tree root -- invisible to assistive technology and compliance checkers that read the document top-down`,
              wcagCriteria: ['1.3.1'],
              location: `Page ${page}`,
              suggestion: 'Reattach the caption\'s /Story wrapper as a sibling of its figure in the structure tree.',
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

    logger.info(
      `[PdfFigureCaptionTreeValidator] ${totalCaptions} caption(s) found, ${issues.length} disconnected from the structure tree`,
    );

    return {
      issues,
      metadata: { totalCaptions, disconnectedCaptions: issues.length },
    };
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
    return resolved instanceof PDFDict ? resolved : undefined;
  }
}

export const pdfFigureCaptionTreeValidator = new PdfFigureCaptionTreeValidator();
