/**
 * PDF Heading-Style Mismatch Validator (detect-only)
 *
 * Matterhorn 01-006 ("The structure type and attributes of a structure
 * element are not semantically appropriate for the structure element") --
 * the SAME checkpoint pdf-rolemap-integrity.validator.ts already uses, but
 * for the OTHER shape that validator's own header comment explicitly calls
 * out of scope: "one specific paragraph visually styled as a heading but
 * tagged with an unrelated, name-ambiguous style" -- the real S4 Carlisle
 * manual QC finding was content that should have been tagged <H1> but was
 * instead tagged <TPT>, a generic/default body-text style used for
 * thousands of other, genuinely-correct body paragraphs in the same
 * document. A RoleMap-level fix cannot touch this: /TPT's own /RoleMap
 * target (/P) is correct for the vast majority of its real uses, so
 * retargeting the whole style would mistag every legitimate paragraph that
 * happens to share it. This is a per-instance defect, not a document-wide
 * one, and needs the per-instance visual heuristic (font size + short text)
 * pdf-rolemap-integrity.validator.ts's own header comment says is "out of
 * scope here, flagged separately for its own investigation" -- this file is
 * that investigation.
 *
 * Scope: already-tagged documents only, same as pdf-rolemap-integrity.
 * validator.ts -- an untagged PDF has no /P struct elements to walk, and
 * Seam-C's own from-scratch retagging pipeline (struct-tree-builder.ts)
 * already assigns heading tags from font size at tagging time (see
 * canonical-to-tag.ts's inferHeadingLevels), so this gap doesn't exist for
 * documents tagged by this platform -- only for already-tagged documents
 * whose ORIGINAL producer (e.g. InDesign) made the mistake.
 *
 * Font size is resolved via tagged-pdf-extractor.ts's own
 * buildContentIdBBoxMap -- the only place in this codebase that derives a
 * real per-content-ID font size from a page's actual getTextContent() text
 * runs -- reused here rather than re-derived. pdfjs's own page.getStructTree()
 * API resolves /RoleMap internally (see that file's own header comment), so
 * a custom style RoleMap'd to /P -- like the real S4 Carlisle document's
 * dozens of InDesign paragraph styles -- surfaces here exactly like a
 * literal /P, with zero RoleMap-resolution code needed in this file.
 *
 * Detect-only, deliberately NOT auto-fixed (no suggestionType routing is
 * registered for this code in ai-analysis.service.ts): promoting a /P to a
 * heading changes document navigation (bookmarks, screen-reader "jump to
 * heading" lists, the document outline), and the false-positive risk
 * against thousands of legitimate body paragraphs sharing the exact same
 * visual style is real. This is the same "bail rather than guess"
 * convention this codebase already uses elsewhere for a confident-but-risky
 * structural change -- see findPrecedingColor (contrast-content-stream.ts)
 * and locateXObjectInvocation (figure-content-tagger.ts) -- and the exact
 * same reasoning pdf-rolemap-integrity.validator.ts's own header comment
 * gives for why its own index/footnote categories are detect-only too.
 *
 * Threshold rationale:
 *   - FONT_SIZE_RATIO_THRESHOLD (1.3x the document's own body-text median):
 *     generous headroom above normal in-document size variance (e.g. a
 *     slightly larger "lead-in" or "drop-cap-adjacent" paragraph style)
 *     while still catching a genuine heading-sized jump. The real S4
 *     Carlisle case was a visually obvious heading-vs-body mismatch, not a
 *     borderline one.
 *   - MAX_HEADING_CANDIDATE_CHARS (150): generous headroom above a
 *     realistic heading/title length (almost always under one line) while
 *     comfortably excluding even a SHORT body paragraph, which still runs to
 *     multiple sentences. Char count alone never flags anything -- see the
 *     AND with font size below -- so a short, normal-sized one-word
 *     sentence (e.g. "Agreed.") is never flagged just for being short.
 *   - MIN_SAMPLE_SIZE (5): below this many real /P elements document-wide,
 *     a median is too noisy to trust -- the same "bail rather than guess"
 *     convention applied to the SAMPLE itself, not just the per-element
 *     decision.
 *   - Document-wide (not per-page) median: per the investigation this
 *     validator builds on, a per-page median risks small-sample skew on a
 *     page with only one or two /P elements (e.g. a mostly-figure page).
 *     A real document's body-text style is overwhelmingly consistent across
 *     pages, so a single document-wide median is the more robust choice
 *     without materially losing sensitivity.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import {
  buildContentIdBBoxMap,
  type ContentIdFontMap,
  type ContentIdTextMap,
} from '../../zone-extractor/tagged-pdf-extractor';
import { logger } from '../../../lib/logger';

export interface HeadingStyleMismatchValidationResult {
  issues: AuditIssue[];
  metadata: {
    paragraphsAnalyzed: number;
    bodyMedianFontSize: number;
    flagged: number;
  };
}

// Minimal local typing for pdfjs's own getStructTree() result shape.
// pdfjs-dist does export StructTreeNode/StructTreeContent types, but
// tagged-pdf-extractor.ts's own PdfjsStructNode/PdfjsStructContent (the
// established convention this file follows) casts through `as unknown as`
// rather than importing them -- kept consistent here rather than mixing
// two different typing strategies for the same runtime shape.
interface StructNode {
  role: string;
  children: (StructNode | StructContent)[];
}

interface StructContent {
  type: string;
  id: string;
}

function isStructContent(child: StructNode | StructContent): child is StructContent {
  return !('role' in child);
}

interface ParagraphCandidate {
  pageNumber: number;
  fontSize: number;
  charCount: number;
  textSample: string;
}

interface FontTextAggregate {
  maxFont: number;
  texts: string[];
}

// See this file's own header comment ("Threshold rationale") for why each
// of these was chosen.
const FONT_SIZE_RATIO_THRESHOLD = 1.3;
const MAX_HEADING_CANDIDATE_CHARS = 150;
const MIN_SAMPLE_SIZE = 5;

class PdfHeadingStyleMismatchValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<HeadingStyleMismatchValidationResult> {
    this.issueCounter = 0;
    const empty: HeadingStyleMismatchValidationResult = {
      issues: [],
      metadata: { paragraphsAnalyzed: 0, bodyMedianFontSize: 0, flagged: 0 },
    };

    // Already-tagged documents only -- see this file's own header comment.
    if (!parsedPdf.structure?.metadata?.isTagged) return empty;

    const pdfjsDoc = parsedPdf.pdfjsDoc;
    if (!pdfjsDoc) return empty;

    const paragraphs: ParagraphCandidate[] = [];

    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
      let structTree: StructNode | null = null;
      let fontMap: ContentIdFontMap;
      let textMap: ContentIdTextMap;
      try {
        const page = await pdfjsDoc.getPage(pageNum);
        const tree = await page.getStructTree();
        if (!tree?.children?.length) continue;
        structTree = tree as unknown as StructNode;

        const maps = await buildContentIdBBoxMap(page);
        fontMap = maps.fontMap;
        textMap = maps.textMap;
      } catch (err) {
        logger.debug(
          `[PdfHeadingStyleMismatchValidator] Could not read page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      this.collectParagraphs(structTree, fontMap, textMap, pageNum, paragraphs);
    }

    if (paragraphs.length < MIN_SAMPLE_SIZE) {
      logger.info(
        `[PdfHeadingStyleMismatchValidator] Only ${paragraphs.length} /P element(s) found -- too few for a reliable body-text median, skipping`,
      );
      return { issues: [], metadata: { paragraphsAnalyzed: paragraphs.length, bodyMedianFontSize: 0, flagged: 0 } };
    }

    const median = this.median(paragraphs.map((p) => p.fontSize).filter((s) => s > 0));
    if (median <= 0) {
      return { issues: [], metadata: { paragraphsAnalyzed: paragraphs.length, bodyMedianFontSize: 0, flagged: 0 } };
    }

    const threshold = median * FONT_SIZE_RATIO_THRESHOLD;
    const issues: AuditIssue[] = [];

    for (const p of paragraphs) {
      if (p.fontSize <= 0 || p.fontSize < threshold) continue;
      if (p.charCount === 0 || p.charCount > MAX_HEADING_CANDIDATE_CHARS) continue;

      issues.push(this.buildIssue(p, median));
    }

    logger.info(
      `[PdfHeadingStyleMismatchValidator] ${paragraphs.length} /P element(s) analyzed, body median ${median.toFixed(1)}pt, ${issues.length} flagged`,
    );

    return {
      issues,
      metadata: { paragraphsAnalyzed: paragraphs.length, bodyMedianFontSize: median, flagged: issues.length },
    };
  }

  private buildIssue(p: ParagraphCandidate, median: number): AuditIssue {
    const ratio = p.fontSize / median;
    return {
      id: `heading-style-mismatch-${++this.issueCounter}`,
      source: 'pdf-heading-style-mismatch',
      severity: 'moderate',
      code: 'HEADING-STYLE-MISMATCH',
      message:
        `A /P (body-text) element on page ${p.pageNumber} is styled at font size ${p.fontSize.toFixed(1)}pt -- ` +
        `${ratio.toFixed(1)}x this document's own body-text median of ${median.toFixed(1)}pt -- and is only ` +
        `${p.charCount} character(s) long, the same visual shape as a heading rather than body-text flow: "${p.textSample}"`,
      wcagCriteria: ['1.3.1'],
      location: `Page ${p.pageNumber}`,
      suggestion:
        'Review this paragraph -- if it functions as a heading (e.g. a section title), retag it as the ' +
        'appropriate /H1-/H6 structure element rather than /P. Flagged for manual review, not auto-fixed: ' +
        'promoting a paragraph to a heading changes document navigation, and many other /P paragraphs in this ' +
        'document may legitimately share the same visual style.',
      category: 'headings',
      pageNumber: p.pageNumber,
      matterhornCheckpoint: '01-006',
      matterhornHow: 'H',
    };
  }

  /**
   * Recursively walks a page's pdfjs struct tree, collecting every node
   * whose role resolves to /P (pdfjs already resolved /RoleMap by the time
   * this tree exists -- see this file's own header comment). For each /P
   * node, aggregates the max font size and total text across every content
   * ID nested beneath it (inline Span/Em/etc. included), via the SAME
   * fontMap/textMap buildContentIdBBoxMap already computed for the whole
   * page -- no independent font-size computation here.
   */
  private collectParagraphs(
    node: StructNode,
    fontMap: ContentIdFontMap,
    textMap: ContentIdTextMap,
    pageNumber: number,
    out: ParagraphCandidate[],
  ): void {
    for (const child of node.children ?? []) {
      if (isStructContent(child)) continue; // a content leaf directly under a non-/P ancestor -- not this validator's concern
      if (child.role === 'P') {
        const agg: FontTextAggregate = { maxFont: 0, texts: [] };
        this.collectContentIds(child, fontMap, textMap, agg);
        const text = agg.texts.join('').trim();
        out.push({ pageNumber, fontSize: agg.maxFont, charCount: text.length, textSample: text.slice(0, 120) });
        // /P elements aren't nested inside each other (PDF32000-1:2008
        // §14.8.4.3 lists /P among block-level elements, not containers) --
        // don't also recurse into this node looking for a nested candidate.
        continue;
      }
      this.collectParagraphs(child, fontMap, textMap, pageNumber, out);
    }
  }

  private collectContentIds(
    node: StructNode,
    fontMap: ContentIdFontMap,
    textMap: ContentIdTextMap,
    agg: FontTextAggregate,
  ): void {
    for (const child of node.children ?? []) {
      if (isStructContent(child)) {
        const size = fontMap.get(child.id);
        if (size && size > agg.maxFont) agg.maxFont = size;
        const texts = textMap.get(child.id);
        if (texts) agg.texts.push(...texts);
      } else {
        this.collectContentIds(child, fontMap, textMap, agg);
      }
    }
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}

export const pdfHeadingStyleMismatchValidator = new PdfHeadingStyleMismatchValidator();
