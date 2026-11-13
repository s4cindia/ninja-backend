/**
 * PDF Structure-Element-Wrong-Parent Validator
 *
 * See structure-parent-mismatch.ts's own header comment for the full real
 * incident (Karsaklian_189165_9781606497623.pdf round 15 -- 49 instances
 * caught by an independent PAC/veraPDF re-check, root-caused to
 * fixReadingOrderFloatInterruption's missing /P update, this codebase's
 * own audit having zero prior coverage for the checkpoint at all).
 *
 * Matches veraPDF's real checkpoint name directly ("Structure element
 * refers to a different parent than the actual parent") -- Matterhorn
 * Protocol clause 1 (Real Content), basic structure-syntax requirement
 * that a struct element's /P and its real /K-tree position agree; PDF/UA-1
 * ISO 14289-1 7.1. Single code, always auto-fixable (unlike most of this
 * file's siblings) -- there is exactly one correct value for /P, no
 * judgment call.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { findStructureParentMismatches } from '../structure-parent-mismatch';
import { logger } from '../../../lib/logger';

export interface StructureParentMismatchValidationResult {
  issues: AuditIssue[];
  metadata: {
    mismatchesFound: number;
  };
}

class PdfStructureParentMismatchValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<StructureParentMismatchValidationResult> {
    this.issueCounter = 0;
    const mismatches = findStructureParentMismatches(parsedPdf.pdfLibDoc);

    const issues: AuditIssue[] = mismatches.map(m => ({
      id: `structure-parent-mismatch-${++this.issueCounter}`,
      source: 'pdf-structure-parent-mismatch',
      severity: 'serious',
      code: 'STRUCTURE-ELEMENT-WRONG-PARENT',
      message:
        `A /${m.tag} element's own /P entry points at object ${m.declaredParentRef.objectNumber}, but it is actually, ` +
        `currently a child of /${m.actualParentS} (object ${m.actualParentRef.objectNumber}) -- the two disagree about this ` +
        'element\'s real parent in the structure tree.',
      wcagCriteria: ['1.3.2'],
      location: m.page !== null ? `Page ${m.page}` : 'Document',
      suggestion: `Update this element's /P to object ${m.actualParentRef.objectNumber}, matching where it actually sits in the structure tree today.`,
      category: 'structure',
      element: `parent-mismatch_r${m.ref.objectNumber}`,
      pageNumber: m.page ?? undefined,
      // Not a Matterhorn Protocol checkpoint -- this is a basic PDF/UA
      // structure-syntax requirement (ISO 32000-1's own /P consistency
      // rule), the same category veraPDF itself files it under
      // ("Basic requirements > PDF Syntax", not a numbered Matterhorn
      // clause). '--' matches this file's own established "not
      // applicable" convention rather than guessing a wrong checkpoint.
      matterhornHow: '--',
    }));

    logger.info(`[PdfStructureParentMismatchValidator] ${issues.length} structure-element-wrong-parent mismatch(es) found`);
    return { issues, metadata: { mismatchesFound: issues.length } };
  }
}

export const pdfStructureParentMismatchValidator = new PdfStructureParentMismatchValidator();
