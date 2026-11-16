/**
 * PDF Span-As-Parent Illegal Nesting Validator
 *
 * See span-illegal-nesting.ts's own header comment for the full S4 QC
 * finding this addresses ("child Span tags incorrectly placed as parent
 * elements", Karsaklian_189165_9781606497623.pdf Round 3, 2026-11-17) and
 * this feature's deliberately narrow scope (Span only, clean-dissolve
 * cases only auto-fixed).
 *
 * Matterhorn 01-006 ("The structure type and attributes of a structure
 * element are not semantically appropriate for the structure element") --
 * the same checkpoint pdf-rolemap-integrity.validator.ts and pdf-heading-
 * style-mismatch.validator.ts already use for other "wrong structure type
 * for this context" shapes; this is ISO 32000-1's inline-vs-block/grouping
 * content-model rule specifically.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { findSpanIllegalNestingViolations } from '../span-illegal-nesting';
import { logger } from '../../../lib/logger';

export interface SpanIllegalNestingValidationResult {
  issues: AuditIssue[];
  metadata: {
    violationsFound: number;
    autoFixable: number;
  };
}

class PdfSpanIllegalNestingValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<SpanIllegalNestingValidationResult> {
    this.issueCounter = 0;
    const violations = findSpanIllegalNestingViolations(parsedPdf.pdfLibDoc);

    const issues: AuditIssue[] = violations.map(v => {
      const childDesc = v.illegalChildTags.length === 1
        ? `a /${v.illegalChildTags[0]} element`
        : `${v.illegalChildTags.length} elements (/${v.illegalChildTags.join(', /')})`;

      return {
        id: `span-illegal-nesting-${++this.issueCounter}`,
        source: 'pdf-span-illegal-nesting',
        severity: 'serious',
        code: v.autoFixable ? 'SPAN-ILLEGAL-NESTING' : 'SPAN-ILLEGAL-NESTING-MANUAL',
        message:
          `A /Span element (an inline-level structure type) directly contains ${childDesc} -- a Grouping, ` +
          'Block-level, or Illustration structure type, which is not legal content for an inline-level ' +
          'element per ISO 32000-1.',
        wcagCriteria: ['1.3.1'],
        location: v.page !== null ? `Page ${v.page}` : 'Document',
        suggestion: v.autoFixable
          ? 'This Span will be dissolved and its child element(s) promoted to sit directly under its own parent, in the same position.'
          : 'This Span mixes illegitimate block-level content with either other legitimate inline content, or sits under a parent that cannot directly hold the dissolved content -- review and correct the nesting manually.',
        category: 'structure',
        element: `span-illegal-nesting_r${v.spanRef.objectNumber}`,
        pageNumber: v.page ?? undefined,
        matterhornCheckpoint: '01-006',
        matterhornHow: 'H',
      };
    });

    const autoFixable = violations.filter(v => v.autoFixable).length;
    logger.info(`[PdfSpanIllegalNestingValidator] ${issues.length} Span-as-parent violation(s) found (${autoFixable} auto-fixable)`);
    return { issues, metadata: { violationsFound: issues.length, autoFixable } };
  }
}

export const pdfSpanIllegalNestingValidator = new PdfSpanIllegalNestingValidator();
