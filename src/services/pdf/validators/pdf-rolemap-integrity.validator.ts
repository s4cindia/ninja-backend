/**
 * PDF RoleMap Integrity Validator
 *
 * Matterhorn 01-006 ("The structure type and attributes of a structure
 * element are not semantically appropriate for the structure element").
 * Confirmed real via a live S4 Carlisle manual QC report plus direct
 * inspection of the exact file they reviewed
 * (Karsaklian_189165_9781606497623.pdf, an "already-tagged" InDesign
 * export this platform's own auto-tag step explicitly skips, per
 * autoTagSkipReason: 'already-tagged'): the document's own /RoleMap maps
 * ~40 distinct custom paragraph-style names to plain /P, including ones
 * whose own names are unambiguous about what they should be --
 * /H1A -> /P, /H2A -> /P (headings), /IDX1-3 -> /P (index entries),
 * /FGC -> /P (figure captions), /TFN -> /P (footnotes). To any RoleMap-
 * resolving consumer (NVDA included -- this is exactly why S4's NVDA pass
 * found nothing where our own dashboard showed 99/100), this collapses
 * headings, index structure, and caption/footnote pairing into
 * undifferentiated body text, regardless of how the content was visually
 * styled.
 *
 * This is a DOCUMENT-WIDE smell test, not a per-instance one: it flags a
 * custom tag name whose own name strongly implies a specific role but
 * whose /RoleMap target is a generic one. It does NOT catch the other
 * shape S4 also found -- one specific paragraph visually styled as a
 * heading but tagged with an unrelated, name-ambiguous style (their own
 * example: "<H1> ... tagged as <TPT>"). That shape requires per-instance
 * visual heuristics (font size/weight/position) similar to Seam-C's
 * from-scratch heading detector, applied to the incremental-fix path --
 * out of scope here, flagged separately for its own investigation.
 *
 * Only HEADING_PATTERN and CAPTION_PATTERN are auto-fixable (see
 * pdf-structure-writer.service.ts's fixDegenerateRoleMapEntry): those two
 * have one unambiguous correct target apiece. INDEX_PATTERN and
 * FOOTNOTE_PATTERN are detect-only -- there's no single correct base
 * PDF/UA structure type to retarget them to without redesigning the
 * surrounding structure (an index entry needs real list/container
 * structure, not just a different /S value; a footnote's correct target
 * is itself debated across PDF/UA profiles) -- flagging for manual review
 * is the honest, safe choice rather than guessing.
 */

import { PDFDict, PDFName, PDFRef, PDFArray } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface RoleMapIntegrityValidationResult {
  issues: AuditIssue[];
  metadata: {
    customTagsDeclared: number;
    customTagsFlagged: number;
  };
}

// A custom tag must actually be USED at least this many times in the tree
// to be flagged -- filters out a one-off style no one ever really applied,
// which isn't evidence of a systemic export problem.
const MIN_USAGE_COUNT = 3;

// Collapsed-to-generic targets a flagged custom tag's own mapping must
// currently resolve to for this to be worth flagging at all -- a custom
// tag already resolving to something specific (e.g. /Figure, /Table) is
// fine regardless of its own name.
const GENERIC_TARGETS = new Set(['P', 'Span', 'Document', 'Part', 'Div', 'Sect', 'Art', 'NonStruct', 'Private']);

export type RoleMapFlattenedCategory = 'heading' | 'caption' | 'index' | 'footnote';

const HEADING_PATTERN = /^H([1-6])/i;
const CAPTION_PATTERN = /^FGC/i;
const INDEX_PATTERN = /^IDX/i;
const FOOTNOTE_PATTERN = /^TFN$/i;

/** Exported so the fixer (auto-fixable categories only) can classify the same way without re-deriving it differently. */
export function classifyDegenerateRoleMapEntry(
  customTag: string
): { category: RoleMapFlattenedCategory; headingLevel?: number } | null {
  const headingMatch = customTag.match(HEADING_PATTERN);
  if (headingMatch) return { category: 'heading', headingLevel: Number(headingMatch[1]) };
  if (CAPTION_PATTERN.test(customTag)) return { category: 'caption' };
  if (INDEX_PATTERN.test(customTag)) return { category: 'index' };
  if (FOOTNOTE_PATTERN.test(customTag)) return { category: 'footnote' };
  return null;
}

const CODE_BY_CATEGORY: Record<RoleMapFlattenedCategory, string> = {
  heading: 'ROLEMAP-HEADING-FLATTENED',
  caption: 'ROLEMAP-CAPTION-FLATTENED',
  index: 'ROLEMAP-INDEX-FLATTENED',
  footnote: 'ROLEMAP-FOOTNOTE-FLATTENED',
};

class PdfRoleMapIntegrityValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<RoleMapIntegrityValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const issues: AuditIssue[] = [];

    const structTreeRootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
    if (!structTreeRootRef) return { issues, metadata: { customTagsDeclared: 0, customTagsFlagged: 0 } };

    const structTreeRoot = doc.context.lookup(structTreeRootRef);
    if (!(structTreeRoot instanceof PDFDict)) {
      return { issues, metadata: { customTagsDeclared: 0, customTagsFlagged: 0 } };
    }

    const roleMap = this.buildRoleMap(doc, structTreeRoot);
    if (roleMap.size === 0) return { issues, metadata: { customTagsDeclared: 0, customTagsFlagged: 0 } };

    const usageCounts = this.countTagUsage(doc, structTreeRoot);

    let customTagsFlagged = 0;
    for (const [customTag, target] of roleMap.entries()) {
      const resolvedTarget = this.resolveRoleMapChain(roleMap, target);
      if (!GENERIC_TARGETS.has(resolvedTarget)) continue;

      const usageCount = usageCounts.get(customTag) ?? 0;
      if (usageCount < MIN_USAGE_COUNT) continue;

      const classification = classifyDegenerateRoleMapEntry(customTag);
      if (!classification) continue;

      customTagsFlagged++;
      const { category, headingLevel } = classification;
      const isAutoFixable = category === 'heading' || category === 'caption';

      issues.push({
        id: `rolemap-integrity-${++this.issueCounter}`,
        source: 'pdf-rolemap-integrity',
        severity: 'serious',
        code: CODE_BY_CATEGORY[category],
        message: `The custom style "/${customTag}" is used ${usageCount} time(s) in this document and its own name ` +
          `implies it should be a ${category}${headingLevel ? ` (level ${headingLevel})` : ''}, but its /RoleMap ` +
          `target resolves to generic /${resolvedTarget} -- assistive technology sees undifferentiated body text ` +
          'wherever this style was used, regardless of how it was visually formatted.',
        category: category === 'heading' ? 'headings' : 'structure',
        element: customTag,
        location: `Document-wide (style: /${customTag})`,
        suggestion: isAutoFixable
          ? `Retarget /RoleMap's "/${customTag}" entry to the correct standard type -- safe and document-wide, ` +
            'since every instance of this specific custom style was deliberately applied by the original author.'
          : `Manual review recommended -- there's no single correct standard-type retarget for a ${category} ` +
            'entry without also restructuring its surrounding container/list structure.',
        wcagCriteria: ['1.3.1', '4.1.2'],
        matterhornCheckpoint: '01-006',
        matterhornHow: 'H',
      });
    }

    logger.info(
      `[PdfRoleMapIntegrityValidator] ${roleMap.size} custom RoleMap entries, ${customTagsFlagged} flagged as degenerate`
    );

    return {
      issues,
      metadata: { customTagsDeclared: roleMap.size, customTagsFlagged },
    };
  }

  /** Same pattern as pdf-structure-writer.service.ts's own buildRoleMap -- duplicated per this project's established preference for isolated per-feature structure-tree helpers over cross-module coupling (see structure-tree-completeness.ts's header comment). */
  private buildRoleMap(doc: ParsedPDF['pdfLibDoc'], structTreeRoot: PDFDict): Map<string, string> {
    const roleMap = new Map<string, string>();
    const rmRaw = structTreeRoot.get(PDFName.of('RoleMap'));
    const rm = rmRaw instanceof PDFRef ? doc.context.lookup(rmRaw) : rmRaw;
    if (!(rm instanceof PDFDict)) return roleMap;

    for (const [key, value] of rm.entries()) {
      const customTag = key.toString().replace(/^\//, '');
      const stdTag = value instanceof PDFName ? value.toString().replace(/^\//, '') : null;
      if (stdTag) roleMap.set(customTag, stdTag);
    }
    return roleMap;
  }

  /** Follows a /RoleMap chain to its end (customA -> customB -> H2), not just one hop -- same reasoning as pdf-structure-writer.service.ts's resolveRoleMapChain. */
  private resolveRoleMapChain(roleMap: Map<string, string>, rawType: string): string {
    const visited = new Set<string>();
    let current = rawType;
    while (roleMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = roleMap.get(current)!;
    }
    return current;
  }

  /** Tallies how many structure elements actually use each raw /S value, at any depth -- a custom tag declared in /RoleMap but never used isn't evidence of anything. */
  private countTagUsage(doc: ParsedPDF['pdfLibDoc'], structTreeRoot: PDFDict): Map<string, number> {
    const counts = new Map<string, number>();
    const visited = new Set<string>();

    const walk = (node: unknown, depth: number): void => {
      if (depth > 200) return; // defensive -- malformed/cyclic trees shouldn't hang this
      if (node instanceof PDFRef) {
        const key = node.toString();
        if (visited.has(key)) return;
        visited.add(key);
        walk(doc.context.lookup(node), depth + 1);
        return;
      }
      if (node instanceof PDFArray) {
        for (let i = 0; i < node.size(); i++) walk(node.get(i), depth + 1);
        return;
      }
      if (node instanceof PDFDict) {
        const s = node.get(PDFName.of('S'));
        if (s) {
          const rawType = s.toString().replace(/^\//, '');
          counts.set(rawType, (counts.get(rawType) ?? 0) + 1);
        }
        const kids = node.get(PDFName.of('K'));
        if (kids) walk(kids, depth + 1);
      }
    };

    walk(structTreeRoot, 0);
    return counts;
  }
}

export const pdfRoleMapIntegrityValidator = new PdfRoleMapIntegrityValidator();
