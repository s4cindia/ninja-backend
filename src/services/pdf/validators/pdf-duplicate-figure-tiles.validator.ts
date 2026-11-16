/**
 * PDF Duplicate Figure Tiles Validator
 *
 * See duplicate-figure-tiles.ts's own header comment for the full S4 QC
 * finding this addresses ("a single image was tagged with two separate
 * Figure tags and contained duplicate alternative text descriptions",
 * Karsaklian_189165_9781606497623.pdf Round 3, 2026-11-17).
 *
 * Matterhorn 13-006 ("Graphics objects that possess semantic value only
 * within a group of graphics objects is tagged on its own") -- exactly
 * this shape: several Figure-tagged tiles that together form one
 * semantic image, each tagged independently rather than as one group.
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { findDuplicateFigureTiles } from '../duplicate-figure-tiles';
import { logger } from '../../../lib/logger';

export interface DuplicateFigureTilesValidationResult {
  issues: AuditIssue[];
  metadata: {
    groupsFound: number;
    duplicateFiguresFound: number;
  };
}

class PdfDuplicateFigureTilesValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<DuplicateFigureTilesValidationResult> {
    this.issueCounter = 0;
    const groups = findDuplicateFigureTiles(parsedPdf.pdfLibDoc);

    const issues: AuditIssue[] = groups.map(g => ({
      id: `duplicate-figure-tiles-${++this.issueCounter}`,
      source: 'pdf-duplicate-figure-tiles',
      severity: 'moderate',
      code: 'DUPLICATE-FIGURE-TILES',
      message:
        `${g.duplicateRefs.length + 1} /Figure elements on this page sit directly adjacent to (or overlapping) one ` +
        `another under the same parent, and all share identical alt text ("${g.altText.slice(0, 80)}${g.altText.length > 80 ? '...' : ''}") -- ` +
        'almost certainly one semantic image tagged as separate tiles rather than as one Figure.',
      wcagCriteria: ['1.1.1'],
      location: `Page ${g.pageNumber}`,
      suggestion: `The ${g.duplicateRefs.length} duplicate Figure element(s) will be merged into the first one -- their content moved in, duplicates removed.`,
      category: 'images',
      element: `duplicate-figure-tiles_r${g.primaryRef.objectNumber}`,
      pageNumber: g.pageNumber,
      matterhornCheckpoint: '13-006',
      matterhornHow: 'H',
    }));

    const duplicateFiguresFound = groups.reduce((sum, g) => sum + g.duplicateRefs.length, 0);
    logger.info(`[PdfDuplicateFigureTilesValidator] ${groups.length} duplicate-figure-tile group(s) found (${duplicateFiguresFound} duplicate Figure(s) total)`);
    return { issues, metadata: { groupsFound: groups.length, duplicateFiguresFound } };
  }
}

export const pdfDuplicateFigureTilesValidator = new PdfDuplicateFigureTilesValidator();
