/**
 * End-to-end test for PdfStructureWriterService.resolveParagraphElementForMcid
 * / fixHeadingPromoteFix against a REAL tagged PDF -- not a synthetic pdf-lib
 * dict fixture. This is deliberately the highest-risk part of the whole
 * heading-promotion feature: pdf-heading-style-mismatch.validator.ts detects
 * via pdfjs's own struct-tree walk, but the fix must retag the real pdf-lib
 * struct element, which pdfjs never exposes a direct reference to. This test
 * proves the (page, MCID) -> real /P struct element correlation actually
 * works against genuinely MCID-marked content, built the same way
 * pdf-heading-style-mismatch.validator.test.ts's own fixture is (reusing
 * Seam-C's real tagger, buildStructTreeFromZones, rather than a hand-built
 * /K-tree dict).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { pdfHeadingStyleMismatchValidator } from '../../../../src/services/pdf/validators/pdf-heading-style-mismatch.validator';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { parseIssueElement } from '../../../../src/services/pdf/heading-style-classifier';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

const PAGE_WIDTH = 2400;
const PAGE_HEIGHT = 792;

interface Line {
  text: string;
  y: number;
  size: number;
}

function zoneForLine(line: Line): OrderableZone {
  return {
    pageNumber: 1,
    zoneType: 'paragraph',
    bbox: { x: 40, y: PAGE_HEIGHT - line.y - line.size * 0.75, w: PAGE_WIDTH - 80, h: line.size * 1.5 },
  };
}

/** Same fixture-building approach as pdf-heading-style-mismatch.validator.test.ts
 *  -- see that file's own header comment for why a real Seam-C-tagged
 *  document is required rather than a synthetic /K-tree dict. Returns both
 *  the pdfjs-backed ParsedPDF (for the validator) and its real pdf-lib
 *  PDFDocument (for the fix, via parsedPdf.pdfLibDoc). */
async function buildTaggedDoc(lines: Line[]): Promise<ParsedPDF> {
  const src = await PDFDocument.create();
  const page = src.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    page.drawText(line.text, { x: 60, y: line.y, size: line.size, font, color: rgb(0, 0, 0) });
  }
  const doc = await PDFDocument.load(await src.save());

  const zones: OrderableZone[] = lines.map(zoneForLine);
  const built = buildStructTreeFromZones(doc, zones);
  expect(built.elements).toBeGreaterThan(0);
  expect(Object.keys(built.droppedZoneCounts)).toHaveLength(0);

  const buffer = Buffer.from(await doc.save());
  return pdfParserService.parseBuffer(buffer, 'heading-promote-fixture.pdf');
}

const BODY_LINES: Line[] = [
  { text: 'The annual report summarizes revenue growth across every regional division for the fiscal year.', y: 680, size: 11 },
  { text: 'Operating margins improved due to disciplined cost management throughout the organization.', y: 630, size: 11 },
  { text: 'Customer retention remained strong despite increased competitive pressure in core markets.', y: 580, size: 11 },
  { text: 'The board approved a new capital allocation framework prioritizing shareholder returns.', y: 480, size: 11 },
  { text: 'International expansion continued with two new offices opened during the second half.', y: 430, size: 11 },
  { text: 'Supply chain investments reduced lead times and improved on-time delivery performance.', y: 380, size: 11 },
];

describe('PdfStructureWriterService.resolveParagraphElementForMcid / fixHeadingPromoteFix (real tagged fixture)', () => {
  it('resolves the real (page, MCID)-flagged /P element and promotes it to /Hn, leaving body text untouched', async () => {
    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const parsedPdf = await buildTaggedDoc(lines);

    const result = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.element).toMatch(/^heading-style-mismatch_p1_mc\d+$/);

    const target = parseIssueElement(issue.element);
    expect(target).not.toBeNull();

    const doc = parsedPdf.pdfLibDoc;
    const ref = pdfStructureWriterService.resolveParagraphElementForMcid(doc, target!.pageNumber, target!.mcid);
    expect(ref).not.toBeNull();

    const dict = doc.context.lookup(ref!) as PDFDict;
    expect(dict.get(PDFName.of('S'))?.toString()).toBe('/P');

    const fixResult = pdfStructureWriterService.fixHeadingPromoteFix(doc, issue, 1);
    expect(fixResult.success).toBe(true);
    expect(fixResult.before).toBe('/P');
    expect(fixResult.after).toBe('/H1');

    // Re-resolve the SAME ref and confirm the retag actually landed, and
    // that nothing else in the tree was touched (same ref, same object,
    // just a different /S value -- renameElement's own MCID-safe guarantee).
    const retaggedDict = doc.context.lookup(ref!) as PDFDict;
    expect(retaggedDict.get(PDFName.of('S'))?.toString()).toBe('/H1');
  });

  it('is idempotent -- re-running after a successful promotion finds nothing left to fix', async () => {
    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const parsedPdf = await buildTaggedDoc(lines);
    const result = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    const issue = result.issues[0];
    const doc = parsedPdf.pdfLibDoc;

    const first = pdfStructureWriterService.fixHeadingPromoteFix(doc, issue, 1);
    expect(first.success).toBe(true);

    // Re-running against the SAME issue after the element is no longer /P --
    // resolveParagraphElementForMcid only ever matches a 'P'-resolved role,
    // so a second attempt correctly finds nothing left to promote.
    const second = pdfStructureWriterService.fixHeadingPromoteFix(doc, issue, 1);
    expect(second.success).toBe(false);
    expect(second.error).toContain('Could not re-confirm');
  });

  it('fails cleanly with no mutation when the issue element id is unrecognized', async () => {
    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const parsedPdf = await buildTaggedDoc(lines);
    const doc = parsedPdf.pdfLibDoc;
    const badIssue = { id: 'issue-1', element: 'not-a-valid-id' } as AuditIssue;

    const result = pdfStructureWriterService.fixHeadingPromoteFix(doc, badIssue, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unrecognized element id');
  });

  it('fails cleanly on an out-of-range heading level', async () => {
    const lines: Line[] = [{ text: 'Executive Summary', y: 740, size: 28 }, ...BODY_LINES];
    const parsedPdf = await buildTaggedDoc(lines);
    const result = await pdfHeadingStyleMismatchValidator.validate(parsedPdf);
    const issue = result.issues[0];
    const doc = parsedPdf.pdfLibDoc;

    const result2 = pdfStructureWriterService.fixHeadingPromoteFix(doc, issue, 7);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('Invalid heading level');
  });

  it('returns null (declines) for an MCID that does not resolve to any real struct element', () => {
    // A bare, freshly-created document has no struct tree at all.
    return PDFDocument.create().then((doc) => {
      const ref = pdfStructureWriterService.resolveParagraphElementForMcid(doc, 1, 0);
      expect(ref).toBeNull();
    });
  });
});
