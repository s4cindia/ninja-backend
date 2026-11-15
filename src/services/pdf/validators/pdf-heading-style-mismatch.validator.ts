/**
 * PDF Heading-Style Mismatch Validator
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
 * Detection itself (thresholds, document-wide median, the font/text walk)
 * now lives in heading-style-classifier.ts, shared with
 * ai-analysis.service.ts's analyzeHeadingStyleMismatch -- the new AI
 * classification pass this validator's own header comment previously said
 * didn't exist ("no suggestionType routing is registered for this code").
 * See that module's header and the "Heading-Style-Mismatch Classifier
 * Design" doc (https://claude.ai/artifact/4CwarLbLEjpTgALdFgnUBD) for why a
 * per-instance promotion is now possible without the false-positive risk
 * this file's own header always correctly worried about: a cluster-size
 * pre-filter (declining outright when many other /P elements document-wide
 * share the same size) plus AI classification with real surrounding-text
 * context, not a blanket "font size says so" auto-fix.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import {
  collectHeadingStyleData,
  buildIssueElement,
  FONT_SIZE_RATIO_THRESHOLD,
  MAX_HEADING_CANDIDATE_CHARS,
  type HeadingStyleCandidate,
} from '../heading-style-classifier';
import { logger } from '../../../lib/logger';

export interface HeadingStyleMismatchValidationResult {
  issues: AuditIssue[];
  metadata: {
    paragraphsAnalyzed: number;
    bodyMedianFontSize: number;
    flagged: number;
  };
}

class PdfHeadingStyleMismatchValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<HeadingStyleMismatchValidationResult> {
    this.issueCounter = 0;
    const { allCandidates, totalCandidateCount, bodyMedianFontSize } = await collectHeadingStyleData(parsedPdf);

    if (allCandidates.length === 0) {
      return { issues: [], metadata: { paragraphsAnalyzed: totalCandidateCount, bodyMedianFontSize: 0, flagged: 0 } };
    }

    const threshold = bodyMedianFontSize * FONT_SIZE_RATIO_THRESHOLD;
    const issues: AuditIssue[] = [];

    for (const c of allCandidates) {
      if (c.fontSize <= 0 || c.fontSize < threshold) continue;
      if (c.charCount === 0 || c.charCount > MAX_HEADING_CANDIDATE_CHARS) continue;

      issues.push(this.buildIssue(c, bodyMedianFontSize));
    }

    logger.info(
      `[PdfHeadingStyleMismatchValidator] ${allCandidates.length} /P element(s) analyzed, body median ${bodyMedianFontSize.toFixed(1)}pt, ${issues.length} flagged`,
    );

    return {
      issues,
      metadata: { paragraphsAnalyzed: allCandidates.length, bodyMedianFontSize, flagged: issues.length },
    };
  }

  private buildIssue(c: HeadingStyleCandidate, median: number): AuditIssue {
    const ratio = c.fontSize / median;
    return {
      id: `heading-style-mismatch-${++this.issueCounter}`,
      source: 'pdf-heading-style-mismatch',
      severity: 'moderate',
      code: 'HEADING-STYLE-MISMATCH',
      message:
        `A /P (body-text) element on page ${c.pageNumber} is styled at font size ${c.fontSize.toFixed(1)}pt -- ` +
        `${ratio.toFixed(1)}x this document's own body-text median of ${median.toFixed(1)}pt -- and is only ` +
        `${c.charCount} character(s) long, the same visual shape as a heading rather than body-text flow: "${c.textSample}"`,
      wcagCriteria: ['1.3.1'],
      location: `Page ${c.pageNumber}`,
      suggestion:
        'Review this paragraph -- if it functions as a heading (e.g. a section title), retag it as the ' +
        'appropriate /H1-/H6 structure element rather than /P. May also be AI-draftable: see ' +
        'ai-analysis.service.ts\'s analyzeHeadingStyleMismatch for the cluster-size + context-aware check.',
      category: 'headings',
      element: buildIssueElement(c.pageNumber, c.mcid),
      pageNumber: c.pageNumber,
      matterhornCheckpoint: '01-006',
      matterhornHow: 'H',
    };
  }
}

export const pdfHeadingStyleMismatchValidator = new PdfHeadingStyleMismatchValidator();
