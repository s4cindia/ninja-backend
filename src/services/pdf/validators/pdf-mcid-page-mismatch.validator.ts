/**
 * PDF MCID Page-Mismatch Validator
 *
 * Confirmed real on a live PAC 2026 report (Karsaklian_189165_9781606497623.pdf,
 * 2026-11-09): "Entry for given MCID missing" on page 54. See
 * mcid-page-mismatch.ts's own header comment for the full real-incident
 * reasoning and the exact shape this catches -- a struct element whose /K
 * mixes a bare MCID (implicitly on the element's own /Pg) with MCR dicts
 * declaring a different, explicit /Pg (confirming it genuinely spans more
 * than one page), where that bare MCID doesn't exist on its own page but
 * does exist on exactly one sibling MCR page in the SAME /K array -- a
 * mis-wrapped entry, not a genuinely dangling one.
 *
 * No specific Matterhorn checkpoint maps to this -- it's a PDF32000 §7.9.7/
 * §14.7.4.4 structural-consistency defect (a low-level content-
 * identification/number-tree syntax issue), not a WCAG-criterion-level
 * concern, so matterhornCheckpoint is left unset, same convention
 * pdf-link-completeness.validator.ts's own syntax-level checks already use.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { findMcidPageMismatches } from '../mcid-page-mismatch';
import { logger } from '../../../lib/logger';

export interface McidPageMismatchValidationResult {
  issues: AuditIssue[];
  metadata: {
    mismatchesFound: number;
  };
}

class PdfMcidPageMismatchValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<McidPageMismatchValidationResult> {
    this.issueCounter = 0;
    const mismatches = findMcidPageMismatches(parsedPdf.pdfLibDoc);

    const issues: AuditIssue[] = mismatches.map(m => ({
      id: `mcid-page-mismatch-${++this.issueCounter}`,
      source: 'pdf-mcid-page-mismatch',
      severity: 'serious',
      code: 'MCID-PAGE-MISMATCH',
      message:
        `A bare MCID ${m.mcid} in a struct element on page ${m.wrongPage} doesn't exist in that page's own content ` +
        `stream, but exists on page ${m.correctPage} (a sibling MCR entry's own declared page in the same struct ` +
        `element) -- likely a mis-wrapped entry that should be an MCR dict, not a bare number.`,
      wcagCriteria: ['1.3.1'],
      location: `Page ${m.wrongPage}`,
      suggestion: `Wrap MCID ${m.mcid} in an MCR dict declaring /Pg for page ${m.correctPage}, matching its sibling entries in the same /K array.`,
      category: 'structure',
      element: `mcid-mismatch_p${m.wrongPage}_mc${m.mcid}`,
      pageNumber: m.wrongPage,
    }));

    logger.info(`[PdfMcidPageMismatchValidator] ${issues.length} mismatch(es) found`);
    return { issues, metadata: { mismatchesFound: issues.length } };
  }
}

export const pdfMcidPageMismatchValidator = new PdfMcidPageMismatchValidator();
