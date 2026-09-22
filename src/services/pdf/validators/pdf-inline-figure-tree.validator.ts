/**
 * PDF Inline-Figure Tree-Reachability Validator
 *
 * Matterhorn 01-005 ("Content is neither marked as Artifact nor tagged as
 * real content"). Confirmed real and live on Math_Weir_PDF.pdf via a fresh
 * PAC/axesPAC report the user shared (round 7): pages 73, 136, and 137 each
 * show a small cluster of "Path object not tagged"/"Text object not tagged"
 * findings, all landing inside figure captions containing inline math/
 * symbol notation (e.g. the dot-accented "V" in "V̇02max"). Direct
 * struct-tree inspection found the real, exact shape: 8 small /Figure
 * struct elements document-wide, each correctly MCID-tagged in the content
 * stream and correctly cross-referenced in /StructTreeRoot's own
 * /ParentTree, but never linked into any parent's /K array — the same
 * disconnection SHAPE as pdf-figure-caption-tree.validator.ts's own /fc
 * caption case (PR #592), but structurally simpler: each one sits inside an
 * already-correct, flat /fc caption /K array (bare MCID numbers interleaved
 * with nested /Span refs, in strict left-to-right reading order) with an
 * exact one-slot gap at its own MCID position — confirmed on all 8 real
 * cases: the MCID immediately before and immediately after the gap both
 * resolve (via /ParentTree) to the SAME containing /fc, which already
 * correctly lists every OTHER MCID/Span in order.
 *
 * This validator stays broad (flags any /Figure that fails the top-down
 * reachability check, regardless of shape) — the narrower "do the left and
 * right MCID neighbors share the same container, with a bare-number entry
 * to splice after" verification is pdf-structure-writer.service.ts's own
 * reattachInlineFigure's job at fix time, matching reattachFigureCaption's
 * own validator/writer split.
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface InlineFigureTreeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalFigures: number;
    disconnectedFigures: number;
  };
}

class PdfInlineFigureTreeValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<InlineFigureTreeValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issues: [], metadata: { totalFigures: 0, disconnectedFigures: 0 } };
    }

    const pageByRef = new Map<string, number>();
    doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

    // Top-down: every StructElem ref actually reachable from the root.
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

    // Bottom-up: every real /Figure StructElem, found by walking the
    // (possibly hierarchical) /ParentTree — mirrors
    // pdf-figure-caption-tree.validator.ts's own walkNumsTree exactly.
    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    if (!(parentTreeDict instanceof PDFDict)) {
      return { issues: [], metadata: { totalFigures: 0, disconnectedFigures: 0 } };
    }

    const seenFigures = new Set<string>();
    let totalFigures = 0;
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
            if (seenFigures.has(key)) continue;
            const resolved = doc.context.lookup(entry);
            if (!(resolved instanceof PDFDict)) continue;
            const rawS = resolved.get(PDFName.of('S'))?.toString().replace(/^\//, '');
            if (rawS !== 'Figure') continue;
            seenFigures.add(key);
            totalFigures++;
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
            const element = `figure_p${page}_mc${minMcid}`;
            issues.push({
              id: `pdf-inline-figure-tree-${++this.issueCounter}`,
              source: 'pdf-inline-figure-tree',
              severity: 'serious',
              code: 'INLINE-FIGURE-DISCONNECTED',
              message: `Inline figure "${element}" on page ${page} is tagged in the content stream and cross-referenced in the ParentTree, but is not reachable from the structure tree root -- invisible to assistive technology and compliance checkers that read the document top-down`,
              wcagCriteria: ['1.3.1'],
              location: `Page ${page}`,
              suggestion: 'Reattach the figure into its enclosing caption\'s own /K array at its natural reading-order position.',
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
      `[PdfInlineFigureTreeValidator] ${totalFigures} figure(s) found, ${issues.length} disconnected from the structure tree`,
    );

    return {
      issues,
      metadata: { totalFigures, disconnectedFigures: issues.length },
    };
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
    return resolved instanceof PDFDict ? resolved : undefined;
  }
}

export const pdfInlineFigureTreeValidator = new PdfInlineFigureTreeValidator();
