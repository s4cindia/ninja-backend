/**
 * PDF Reading-Order Float-Interruption Validator
 *
 * Confirmed real on a live S4 Carlisle manual QC report
 * (Karsaklian_189165_9781606497623.pdf, Round 2, item #2): "Highlight tags
 * were not associated with their respective content locations. Instead,
 * many highlight tags were found grouped at the end of the document." See
 * reading-order-float.ts's own header comment for the full real-incident
 * reasoning -- direct inspection found no literal /Highlight anywhere in
 * the file; the real shape is 27 top-level struct-tree siblings (epigraph
 * pull-quotes, standalone tables, floated figure+caption groups, cover
 * figures) whose own page ranges all fall inside the book's one big flat
 * flow container's own range, yet are array-positioned AFTER it -- so a
 * reader walking the struct tree in order reads the entire 185-page body
 * first, then every one of these detached pieces, right before the
 * back-matter Index.
 *
 * Matterhorn Protocol Checkpoint 09, failure condition 09-001 ("Tags are
 * not in logical reading order") -- verified via the PDF Association's own
 * Matterhorn 1.1 checklist (reproduced by powermapper.com's PDF/UA-1
 * Matterhorn rule list). 09-001 is human-testing-only (no automated rule),
 * which is exactly why this was caught by S4's manual QC and never by
 * PAC's own automated checker. This codebase's existing
 * 'MATTERHORN-09-004' references elsewhere are a pre-existing mislabeling
 * (09-004 is really about table structure syntax, ISO 32000-1 Table 337,
 * and is never actually produced by any validator) -- deliberately not
 * reused or touched here; this validator uses its own, correctly-verified
 * 09-001 checkpoint and its own non-colliding codes.
 *
 * Two codes, same split discipline as pdf-rolemap-integrity.validator.ts's
 * CODE_BY_CATEGORY: READING-ORDER-FLOAT-INTERRUPTION when
 * findFloatInterruptions found an unambiguous MCID-interpolated splice
 * point (auto-fixable -- see PdfStructureWriterService's
 * fixReadingOrderFloatInterruption), READING-ORDER-FLOAT-INTERRUPTION-MANUAL
 * when it didn't (the misplaced element's range is nested inside a single
 * flow-container sibling rather than falling cleanly between two of them --
 * no dispatch wiring exists for this code, matching
 * pdf-header-footer-content.validator.ts's own established convention for
 * a real-but-harder-to-safely-auto-fix case).
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { findFloatInterruptions } from '../reading-order-float';
import { logger } from '../../../lib/logger';

export interface ReadingOrderFloatValidationResult {
  issues: AuditIssue[];
  metadata: {
    interruptionsFound: number;
    autoFixable: number;
  };
}

class PdfReadingOrderFloatValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<ReadingOrderFloatValidationResult> {
    this.issueCounter = 0;
    const interruptions = findFloatInterruptions(parsedPdf.pdfLibDoc);

    const issues: AuditIssue[] = interruptions.map(f => {
      const autoFixable = f.anchor !== null;
      return {
        id: `reading-order-float-${++this.issueCounter}`,
        source: 'pdf-reading-order-float',
        severity: 'serious',
        code: autoFixable ? 'READING-ORDER-FLOAT-INTERRUPTION' : 'READING-ORDER-FLOAT-INTERRUPTION-MANUAL',
        message:
          `A /${f.misplacedS} element (page${f.minPage === f.maxPage ? ` ${f.minPage}` : `s ${f.minPage}-${f.maxPage}`}) is tagged as a ` +
          `top-level sibling of /${f.containerS}, the document's own main flow container, but is array-positioned AFTER it -- so a reader ` +
          `walking the structure tree in order reads /${f.containerS}'s entire remaining span before ever reaching this element, even ` +
          `though its real content sits earlier, inside that same span.`,
        wcagCriteria: ['1.3.2'],
        location: `Page ${f.minPage}`,
        suggestion: autoFixable
          ? `Relocate this element into the main flow container at the position matching its own page/content, immediately after its ` +
            'confirmed neighbor there -- safe, since no content-stream bytes or MCIDs change, only where in the structure tree this ' +
            'element is reachable from.'
          : `Manual review recommended -- this element's own content range doesn't fall cleanly between two of the main flow container's ` +
            'direct children (it is nested inside a single one of them instead), so no unambiguous relocation position can be determined ' +
            'without risk of guessing wrong.',
        category: 'reading-order',
        element: `float-interruption_r${f.misplacedRef.objectNumber}`,
        pageNumber: f.minPage,
        matterhornCheckpoint: '09-001',
        matterhornHow: 'H',
      };
    });

    const autoFixable = issues.filter(i => i.code === 'READING-ORDER-FLOAT-INTERRUPTION').length;
    logger.info(`[PdfReadingOrderFloatValidator] ${issues.length} float interruption(s) found (${autoFixable} auto-fixable)`);
    return { issues, metadata: { interruptionsFound: issues.length, autoFixable } };
  }
}

export const pdfReadingOrderFloatValidator = new PdfReadingOrderFloatValidator();
