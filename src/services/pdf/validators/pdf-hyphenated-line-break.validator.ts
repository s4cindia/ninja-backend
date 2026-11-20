/**
 * PDF Hyphenated Line Break Validator
 *
 * S4 QC "Hyphenated Words Not Merged Correctly" finding (DuBrin_FOB_8e.pdf,
 * 2026-11-20): a word split by ordinary line-wrap hyphenation ("exam-" /
 * "ple") is announced by a screen reader, and reported by an ActualText-
 * aware PDF/UA validator, as two separate fragments. See
 * pdf-structure-writer.service.ts's fixHyphenatedLineBreak (and its shared
 * detection half, findHyphenatedLineBreaksOnPage) for the full scope and
 * heuristic -- this validator just calls that same detection function once
 * per page and reports one issue per pair found.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { pdfStructureWriterService } from '../pdf-structure-writer.service';
import { logger } from '../../../lib/logger';

export interface HyphenatedLineBreakValidationResult {
  issues: AuditIssue[];
  metadata: {
    pairsFound: number;
  };
}

class PdfHyphenatedLineBreakValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<HyphenatedLineBreakValidationResult> {
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];
    const doc = parsedPdf.pdfLibDoc;
    const pageCount = doc.getPageCount();

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let found;
      try {
        found = pdfStructureWriterService.findHyphenatedLineBreaksOnPage(doc, pageNumber);
      } catch (error) {
        logger.warn(`[PdfHyphenatedLineBreakValidator] Page ${pageNumber} detection failed (non-fatal, skipping): ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!found) continue;

      for (const pair of found.pairs) {
        issues.push({
          id: `hyphenated-line-break-${++this.issueCounter}`,
          source: 'pdf-hyphenated-line-break',
          severity: 'minor',
          code: 'HYPHENATED-LINE-BREAK',
          message: `Page ${pageNumber}: a word split by line-wrap hyphenation ("${pair.mergedWord}") is announced/reported as two separate fragments instead of one word.`,
          wcagCriteria: ['1.3.1'],
          location: `Page ${pageNumber}`,
          suggestion: `Override the first fragment's /ActualText to "${pair.mergedWord}" and suppress the second fragment's own announcement -- the PDF's underlying text-show operators are left untouched (see fixHyphenatedLineBreak's own doc comment for the exact, deliberate scope limit: this fixes screen-reader/validator reading, not raw copy/paste or text search).`,
          category: 'structure',
          pageNumber,
        });
      }
    }

    logger.info(`[PdfHyphenatedLineBreakValidator] ${issues.length} hyphenated line-break pair(s) found across ${pageCount} page(s)`);
    return { issues, metadata: { pairsFound: issues.length } };
  }
}

export const pdfHyphenatedLineBreakValidator = new PdfHyphenatedLineBreakValidator();
