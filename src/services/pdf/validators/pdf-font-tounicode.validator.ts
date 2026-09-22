/**
 * PDF Font ToUnicode Coverage Validator
 *
 * Matterhorn checkpoint CP10-001 ("Character code cannot be mapped to
 * Unicode", font encoding analysis) — pdf-supplemental.validator.ts's own
 * header comment already documents this checkpoint as "Intentionally
 * deferred to veraPDF (Step 4)", but nothing in this codebase actually
 * detects it for a document that never runs veraPDF (or whose veraPDF
 * findings aren't wired into Auto Mode's own suggestion dispatch).
 *
 * Confirmed real and live on Math_Weir_PDF.pdf via a fresh PAC/axesPAC
 * report the user shared (round 7): 858 "Characters in a text object
 * cannot be mapped to Unicode" findings, spread across many pages (e.g.
 * pages 56/69, both formula-heavy). Direct inspection of the real,
 * downloaded PDF found the exact cause: 705 of 1080 real font objects
 * (including the SymbolMT math-symbol font and several ACaslonPro body-text
 * font resources) carry no /ToUnicode CMap at all.
 *
 * The synthesis fix already exists and is already proven — this
 * codebase's own font-tounicode.service.ts (built for Seam-C's from-scratch
 * tagging pipeline, "Seam C — recommendation #3") deterministically
 * synthesizes a /ToUnicode CMap for every simple font missing one, live-
 * confirmed to fix 703 of these 705 real fonts in a single pass on this
 * exact document. The gap was never a missing capability, only that it's
 * bundled exclusively inside seam-c-tag.service.ts's own tagPdf, which
 * throws SEAM_C_ALREADY_TAGGED and never runs at all for a document (like
 * this one) that arrived already tagged by its original producer — the
 * same "capability exists, never dispatched for this document" shape as
 * several other fixes this session (pdf-artifact-tagger.ts's own doc
 * comment documents the identical gating pattern for untagged paint runs).
 *
 * This validator emits a single, document-level issue (mirroring
 * PDFUA_IDENTIFIER_CODES's own "one deterministic whole-document fix"
 * convention in ai-analysis.service.ts) whenever any font actually
 * referenced by some page's own /Resources is missing /ToUnicode — the
 * fix itself (fontToUnicodeService.synthesizeToUnicode) already handles
 * the whole document in one call, so there's no benefit to emitting one
 * issue per font or per page.
 */

import { PDFName, PDFDict, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface FontToUnicodeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalFontsReferenced: number;
    fontsMissingToUnicode: number;
  };
}

// Mirrors font-tounicode.service.ts's own SIMPLE_FONT_SUBTYPES exactly --
// Type0/CIDFont fonts are out of scope for that synthesis, so flagging one
// here would produce an issue the fix can never actually resolve.
const SIMPLE_FONT_SUBTYPES = new Set(['/Type1', '/TrueType', '/MMType1', '/Type3']);

class PdfFontToUnicodeValidator {
  async validate(parsedPdf: ParsedPDF): Promise<FontToUnicodeValidationResult> {
    const doc = parsedPdf.pdfLibDoc;

    // Only fonts actually reachable from some page's own /Resources /Font
    // dict count -- an orphaned font object sitting unused elsewhere in
    // the file (not uncommon after remediation rounds swap fonts in/out)
    // never renders any real character, so flagging it would report a
    // defect nothing on the page actually exhibits.
    const referencedFontRefs = new Set<string>();
    let pageCount: number;
    try {
      pageCount = doc.getPageCount();
    } catch (err) {
      logger.debug(`[PdfFontToUnicodeValidator] Could not read page count: ${err instanceof Error ? err.message : String(err)}`);
      return { issues: [], metadata: { totalFontsReferenced: 0, fontsMissingToUnicode: 0 } };
    }

    for (let i = 0; i < pageCount; i++) {
      let page;
      try {
        page = doc.getPage(i);
      } catch {
        continue;
      }
      const resourcesRaw = page.node.get(PDFName.of('Resources'));
      const resources = resourcesRaw instanceof PDFRef ? doc.context.lookup(resourcesRaw) : resourcesRaw;
      if (!(resources instanceof PDFDict)) continue;
      const fontDictRaw = resources.get(PDFName.of('Font'));
      const fontDict = fontDictRaw instanceof PDFRef ? doc.context.lookup(fontDictRaw) : fontDictRaw;
      if (!(fontDict instanceof PDFDict)) continue;
      for (const key of fontDict.keys()) {
        const fRaw = fontDict.get(key);
        if (fRaw instanceof PDFRef) referencedFontRefs.add(fRaw.toString());
      }
    }

    let missing = 0;
    // Resolve each referenced font ref and check /ToUnicode coverage.
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!referencedFontRefs.has(ref.toString())) continue;
      if (!(obj instanceof PDFDict)) continue;
      const subtype = obj.get(PDFName.of('Subtype'))?.toString();
      if (!subtype || !SIMPLE_FONT_SUBTYPES.has(subtype)) continue;
      if (!obj.has(PDFName.of('ToUnicode'))) missing++;
    }

    if (missing === 0) {
      return { issues: [], metadata: { totalFontsReferenced: referencedFontRefs.size, fontsMissingToUnicode: 0 } };
    }

    logger.info(`[PdfFontToUnicodeValidator] ${missing} of ${referencedFontRefs.size} referenced font(s) missing /ToUnicode`);

    const issue: AuditIssue = {
      id: 'pdf-font-tounicode-1',
      source: 'pdf-font-tounicode',
      severity: 'serious',
      code: 'FONT-TOUNICODE-MISSING',
      message: `${missing} font(s) used in this document have no /ToUnicode CMap -- their characters cannot be mapped to Unicode, so assistive technology and compliance checkers cannot read the text they render`,
      wcagCriteria: ['1.3.1'],
      suggestion: 'Synthesize a /ToUnicode CMap for every affected font from its own /Encoding (or a Private-Use-Area fallback when no real mapping can be derived).',
      category: 'structure',
      matterhornCheckpoint: '10-001',
      matterhornHow: 'M',
    };

    return {
      issues: [issue],
      metadata: { totalFontsReferenced: referencedFontRefs.size, fontsMissingToUnicode: missing },
    };
  }
}

export const pdfFontToUnicodeValidator = new PdfFontToUnicodeValidator();
