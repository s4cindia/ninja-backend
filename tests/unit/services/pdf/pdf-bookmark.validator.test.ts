/**
 * Tests for PDF Bookmark Validator
 *
 * Real Math_Weir_PDF.pdf incident: BOOKMARK-MISSING (and its sibling
 * BOOKMARK-INSUFFICIENT) omitted pageNumber entirely, unlike every other
 * document-level issue elsewhere in the codebase (pdf-structure.validator.ts's
 * missing-title/missing-language/multiple-H1 issues all anchor to page 1).
 * BaseAuditService.calculateAffectedPageRatio treats a severity bucket with
 * NO page-numbered issues as affecting 100% of pages -- correct for a
 * genuinely whole-document concern, but this meant that once
 * HEADING-MULTIPLE-H1 (page 1, same 'moderate' bucket) got fixed,
 * BOOKMARK-MISSING became the bucket's sole occupant and that fallback
 * alone swung the accessibility score from 91 to 53, despite the document
 * becoming MORE accessible. Fixed by anchoring both to page 1, matching the
 * established convention.
 */

import { describe, it, expect } from 'vitest';
import { pdfBookmarkValidator } from '../../../../src/services/pdf/validators/pdf-bookmark.validator';
import { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import { PDFOutlineItem } from '../../../../src/services/pdf/pdf-parser.service';

function makeParsed(pageCount: number, outline: PDFOutlineItem[]): PdfParseResult {
  return {
    metadata: {
      pdfVersion: '1.7',
      isEncrypted: false,
      isLinearized: false,
      isTagged: true,
      hasOutline: outline.length > 0,
      hasAcroForm: false,
      hasXFA: false,
      pageCount,
      hasStructureTree: true,
    },
    pages: [],
    isTagged: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedPdf: { structure: { outline } } as any,
  };
}

describe('PdfBookmarkValidator', () => {
  it('anchors BOOKMARK-MISSING to page 1, not leaving it document-level with no pageNumber', async () => {
    const issues = await pdfBookmarkValidator.validate(makeParsed(50, []));

    const missing = issues.find(i => i.code === 'BOOKMARK-MISSING');
    expect(missing).toBeTruthy();
    expect(missing!.pageNumber).toBe(1);
  });

  it('anchors BOOKMARK-INSUFFICIENT to page 1 too', async () => {
    // 30 pages, 1 bookmark -- well under the recommended ceil(30/15)=2.
    const outline: PDFOutlineItem[] = [{ title: 'Chapter 1', destination: 1, children: [] }];
    const issues = await pdfBookmarkValidator.validate(makeParsed(30, outline));

    const insufficient = issues.find(i => i.code === 'BOOKMARK-INSUFFICIENT');
    expect(insufficient).toBeTruthy();
    expect(insufficient!.pageNumber).toBe(1);
  });

  it('still anchors BOOKMARK-GENERIC-TEXT to its own real bookmark page, not page 1', async () => {
    const outline: PDFOutlineItem[] = [
      { title: 'Section 1', destination: 7, children: [] },
    ];
    const issues = await pdfBookmarkValidator.validate(makeParsed(50, outline));

    const generic = issues.find(i => i.code === 'BOOKMARK-GENERIC-TEXT');
    expect(generic).toBeTruthy();
    expect(generic!.pageNumber).toBe(7);
  });
});
