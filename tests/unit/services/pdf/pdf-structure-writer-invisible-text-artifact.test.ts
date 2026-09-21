/**
 * Regression coverage for fixInvisibleTextArtifact (Matterhorn 01-005-
 * adjacent fix): wraps a SPECIFIC text run -- one whose measured ink color
 * exactly matches its background -- in /Artifact BMC … EMC, located the
 * same way pdf-contrast-writer.service.ts's own fixColorContrast locates a
 * run (contrast-content-stream.ts's locateTextRun, from the issue's own
 * boundingBox). Confirmed real on Math_Weir_PDF.pdf: 55 of 88 real
 * COLOR-CONTRAST issues (identified by the ABSENCE of contrastData) are
 * print-production slug-line text that should never have been in the
 * accessible reading order at all.
 *
 * A run sitting inside a real (non-/Artifact) structure element's own
 * marked-content span can't just be wrapped in place -- that would leave
 * it nested inside tagged content (Matterhorn 01-003), a different real
 * defect. Confirmed real and UNIVERSAL on Math_Weir_PDF.pdf: all 55 real
 * cases sit inside a /Figure's own span (the Illustrator/InDesign "Place"
 * pipeline embeds slug-line text alongside the Figure's real image
 * content, under one shared MCID) -- so the fix must relocate the run's
 * own self-contained text object out of the tagged region before wrapping
 * it (relocateAndWrapInvisibleText), not merely refuse. See that method's
 * own doc comment for the three safety gates (CTM match, self-contained
 * block, color preservation) and the final render-based verification.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// Same shape as contrast-content-stream.test.ts's own twoLineStream (a
// verified-reliable pdf-lib output shape: q BT … Tm … Tj … ET Q).
const SLUG_LINE_STREAM = `q
BT
1 1 1 rg
/F1 8 Tf
1 0 0 1 250 493 Tm
<4539343732> Tj
ET
Q
`;

function invisibleTextIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'contrast-1',
    source: 'contrast-validator',
    severity: 'serious',
    code: 'COLOR-CONTRAST',
    message: 'Text on page 1 has no visually distinguishable ink from its background',
    wcagCriteria: ['1.4.3'],
    location: 'Page 1 at (250, 347)',
    category: 'contrast',
    pageNumber: 1,
    // pageHeight - boundingBox.y must equal the Tm's own baselineY (493) --
    // matches pdf-contrast-writer.service.ts's own {x, baselineY} derivation.
    boundingBox: { x: 250, y: 792 - 493, width: 165, height: 8, pageWidth: 612, pageHeight: 792 },
    // Deliberately NO contrastData -- the exact signal that distinguishes
    // this case from a real, measurable low-contrast defect.
    ...overrides,
  } as AuditIssue;
}

describe('fixInvisibleTextArtifact', () => {
  it('locates the invisible text run by its boundingBox and wraps it in /Artifact BMC…EMC', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('marked as /Artifact');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('/Artifact BMC');
    expect(fixed).not.toContain('/Artifact BDC'); // bare tag, matching pdf-artifact-tagger.ts's own convention
    expect(fixed).toContain('<4539343732> Tj'); // the text itself is untouched, only wrapped
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ pageNumber: undefined })]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('pageNumber or boundingBox');
  });

  it('fails cleanly when the issue has no boundingBox', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ boundingBox: undefined })]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('pageNumber or boundingBox');
  });

  it('fails cleanly when no text run matches the given position (already fixed, or moved)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    // Way outside locateTextRun's own tolerance for this content.
    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(
      doc, [invisibleTextIssue({ boundingBox: { x: 500, y: 700, width: 10, height: 8, pageWidth: 612, pageHeight: 792 } })],
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Could not locate');
  });

  it('never alters the run\'s own text content or positioning -- only inserts marked-content tags', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('1 0 0 1 250 493 Tm');
    expect(fixed).toContain('1 1 1 rg'); // fill color left exactly as-is -- no recoloring attempt
  });

  it('targets the correct page among several, leaving the others untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePageContent(doc, 1, 'q BT 1 1 1 rg /F1 8 Tf 1 0 0 1 10 10 Tm <41> Tj ET Q\n');
    writePageContent(doc, 2, SLUG_LINE_STREAM);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ pageNumber: 2 })]);

    expect(results[0].success).toBe(true);
    expect(decodePageContent(doc, 1)).not.toContain('/Artifact'); // untouched
    expect(decodePageContent(doc, 2)).toContain('/Artifact BMC');
  });

  it('still wraps a run nested only inside another /Artifact tag (no real content is being nested inside)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const wrapped = `/Artifact BMC\n${SLUG_LINE_STREAM}EMC\n`;
    writePageContent(doc, 1, wrapped);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    expect(results[0].success).toBe(true);
  });

  it('rejects a low-confidence match rather than risk wrapping the wrong run, matching pdf-contrast-writer.service.ts\'s own MIN_APPLY_CONFIDENCE bar', async () => {
    // Same twoLineStream shape as contrast-content-stream.test.ts's own
    // "returns a lower confidence tier for a moderately-off target" case:
    // 8pt off line 1's baseline (150) -- within the 12pt tolerance, but
    // only confidence 0.60 (below the 0.80 apply bar).
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const twoLineStream = `q\nBT\n1 1 1 rg\n/F1 12 Tf\n24 TL\n1 0 0 1 50 150 Tm\n<48656C6C6F> Tj\nT*\nET\nQ\nq\nBT\n1 1 1 rg\n/F1 12 Tf\n24 TL\n1 0 0 1 50 120 Tm\n<5365636F6E64> Tj\nT*\nET\nQ\n`;
    writePageContent(doc, 1, twoLineStream);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(
      doc, [invisibleTextIssue({ boundingBox: { x: 50, y: 792 - 142, width: 40, height: 8, pageWidth: 612, pageHeight: 792 } })],
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('confidence');
    expect(decodePageContent(doc, 1)).not.toContain('/Artifact');
  });

  it('rejects an ambiguous match (a near-equally-close runner-up) rather than guess which line is the real target', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // Two lines 2pt apart -- well within locateTextRun's own ambiguity margin.
    const closeLines = `q BT 1 1 1 rg 1 0 0 1 50 150 Tm <41> Tj ET Q\nq BT 1 1 1 rg 1 0 0 1 50 148 Tm <42> Tj ET Q\n`;
    writePageContent(doc, 1, closeLines);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(
      doc, [invisibleTextIssue({ boundingBox: { x: 50, y: 792 - 150, width: 10, height: 8, pageWidth: 612, pageHeight: 792 } })],
    );

    expect(results[0].success).toBe(false);
    expect(decodePageContent(doc, 1)).not.toContain('/Artifact');
  });
});

describe('fixInvisibleTextArtifact — relocating a run out of real tagged content', () => {
  // A run nested inside a real structure element needs an actual real
  // render (its enclosing text object's Figure "sibling" content, and the
  // relocated copy itself, both go through pdfjs+canvas via
  // verifyStillNoDetectableInk) -- page.drawText gives a properly embedded
  // font, unlike this file's other fixtures' bare, undefined /F1
  // reference, which pdfjs cannot render at all.
  async function realInvisiblePage(): Promise<{ doc: PDFDocument; rawBlock: string }> {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 700]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Slug line text', { x: 60, y: 450, size: 14, font, color: rgb(1, 1, 1) });
    const doc = await PDFDocument.load(await src.save());
    const rawBlock = decodePageContent(doc, 1)!;
    return { doc, rawBlock };
  }

  function relocatableIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
    return invisibleTextIssue({
      boundingBox: { x: 60, y: 700 - 450, width: 100, height: 14, pageWidth: 400, pageHeight: 700 },
      ...overrides,
    });
  }

  it('relocates a run out of a real /Figure\'s own tagged content, preserving the Figure\'s other real content', async () => {
    const { doc, rawBlock } = await realInvisiblePage();
    // Mirrors the real, confirmed Math_Weir_PDF.pdf shape: the slug-line
    // run sits inside a /Figure's own marked-content span, alongside the
    // Figure's other real (non-text) content -- represented here by a
    // trailing fill rectangle that must survive untouched.
    const wrapped = `/Figure <</MCID 0>>BDC\n${rawBlock}q\n0 0 0 rg\n10 10 5 5 re\nf\nQ\nEMC\n`;
    writePageContent(doc, 1, wrapped);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [relocatableIssue()]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('relocated');

    const fixed = decodePageContent(doc, 1)!;
    const artifactPos = fixed.indexOf('/Artifact BMC');
    const figurePos = fixed.indexOf('/Figure');
    expect(artifactPos).toBeGreaterThan(-1);
    expect(figurePos).toBeGreaterThan(artifactPos); // relocated BEFORE the Figure's own BDC, fully outside its span
    expect(fixed).toContain('10 10 5 5 re'); // the Figure's other real content is untouched

    const figureBodyStart = fixed.indexOf('BDC', figurePos) + 'BDC'.length;
    const figureBody = fixed.slice(figureBodyStart, fixed.lastIndexOf('EMC'));
    expect(figureBody).not.toContain('Tj'); // no text-show op remains inside the Figure's own span
  });

  it('relocates a run that relies on an ambient (not its own) fill color, explicitly restoring it', async () => {
    const { doc, rawBlock } = await realInvisiblePage();
    // Strip the run's own color op -- matching real Math_Weir cases where
    // no explicit fill-color op sits inside the run's own text object at
    // all, relying entirely on whatever was ambient beforehand.
    const withoutOwnColor = rawBlock.replace('1 1 1 rg\n', '');
    const wrapped = `1 1 1 rg\n/Figure <</MCID 0>>BDC\n${withoutOwnColor}EMC\n`;
    writePageContent(doc, 1, wrapped);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [relocatableIssue()]);

    expect(results[0].success).toBe(true);
    const fixed = decodePageContent(doc, 1)!;
    const artifactPos = fixed.indexOf('/Artifact BMC');
    expect(artifactPos).toBeGreaterThan(-1);
    // The restored color is explicit in the relocated copy, not relying on
    // whatever happens to be ambient at the new position.
    expect(fixed.slice(artifactPos, fixed.indexOf('/Figure'))).toContain('1 1 1 rg');
  });

  it('preserves a clip rectangle that makes the run invisible in its original position -- NOT color-matching -- reproducing it at the relocated position', async () => {
    // Root-caused live on Math_Weir_PDF.pdf: an earlier version of this
    // fix only preserved fill COLOR, silently dropping the run's own clip
    // rectangle when relocating it. All 55 real invisible-slug-line-text
    // cases turned out to be invisible because their baseline sits just
    // below their own clip rect's bottom edge (plain BLACK ink, clipped
    // entirely out of view) -- NOT because of color-matching. Relocating
    // without reproducing that clip made the text render as fully visible
    // black ink (caught by this fix's own render-based verify step, which
    // correctly refused and reverted before this test existed). Plain
    // black ink here (not white-on-white, unlike this file's other
    // fixtures) specifically exercises that clip-only invisibility path.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 700]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Slug line text', { x: 60, y: 450, size: 14, font, color: rgb(0, 0, 0) });
    const doc = await PDFDocument.load(await src.save());
    const rawBlock = decodePageContent(doc, 1)!;
    // This test supplies its own clip rectangle (instead of pdf-lib's own
    // q…Q wrapper) with a bottom edge (y=500) well above the text's own
    // ~450-464 vertical extent -- excluding it from the visible region
    // entirely, the same shape confirmed live.
    const btEtOnly = rawBlock.slice(rawBlock.indexOf('BT'), rawBlock.indexOf('ET') + 2);
    const wrapped = `/Figure <</MCID 0>>BDC\nq\n0 500 400 200 re\nW n\n${btEtOnly}\nQ\nEMC\n`;
    writePageContent(doc, 1, wrapped);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [relocatableIssue()]);

    expect(results[0].success).toBe(true);
    const fixed = decodePageContent(doc, 1)!;
    const artifactPos = fixed.indexOf('/Artifact BMC');
    expect(artifactPos).toBeGreaterThan(-1);
    // The clip rectangle is reproduced in the relocated copy, not dropped.
    expect(fixed.slice(artifactPos, fixed.indexOf('/Figure'))).toContain('0 500 400 200 re');
  });

  it('bails to struct-tree-level handling when the enclosing q…Q establishes a non-rectangular clip this fix doesn\'t recognize as safe to reproduce', async () => {
    const { doc, rawBlock } = await realInvisiblePage();
    const btEtOnly = rawBlock.slice(rawBlock.indexOf('BT'), rawBlock.indexOf('ET') + 2);
    // A triangular (path-based) clip instead of a plain rectangle --
    // findClipPreamble's whitelist deliberately doesn't recognize m/l/c
    // path-construction operators as safe to blindly reproduce.
    const wrapped = `/Figure <</MCID 0>>BDC\nq\n0 0 m\n100 0 l\n50 100 l\nh\nW n\n${btEtOnly}\nQ\nEMC\n`;
    writePageContent(doc, 1, wrapped);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [relocatableIssue()]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('graphics state established between its enclosing q and its own BT');
    expect(results[0].error).toContain('struct-tree-level handling');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).not.toContain('/Artifact');
  });

  it('bails to struct-tree-level handling when the ambient transform at the insertion point differs from the run\'s own', async () => {
    const { doc, rawBlock } = await realInvisiblePage();
    // A `cm` translation between the Figure's own BDC and the run's `q`
    // means the CTM at the Figure's BDC (identity) differs from the CTM at
    // the run's own position -- relocating would shift its rendered page
    // position.
    const shiftedBlock = rawBlock.replace('q\nBT', 'q\n1 0 0 1 100 100 cm\nBT');
    const wrapped = `/Figure <</MCID 0>>BDC\n${shiftedBlock}EMC\n`;
    writePageContent(doc, 1, wrapped);

    // Device-space anchor is now (60+100, 450+100) = (160, 550).
    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(
      doc, [relocatableIssue({ boundingBox: { x: 160, y: 700 - 550, width: 100, height: 14, pageWidth: 400, pageHeight: 700 } })],
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('ambient transform');
    expect(results[0].error).toContain('struct-tree-level handling');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).not.toContain('/Artifact'); // left completely untouched
  });

  it('bails to struct-tree-level handling when the run\'s own text object contains a disallowed operator (not a simple, self-contained block)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // A stray q/Q pair inside BT/ET is illegal PDF (PDF32000-1:2008 Annex
    // A) but pdfjs tolerates it silently -- this fix must still refuse to
    // relocate it rather than risk splicing a malformed document further.
    const malformed = `/Figure <</MCID 0>>BDC\nBT\n1 1 1 rg\n/F1 8 Tf\n1 0 0 1 250 493 Tm\nq\n<4539343732> Tj\nQ\nET\nEMC\n`;
    writePageContent(doc, 1, malformed);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('self-contained');
    expect(results[0].error).toContain('struct-tree-level handling');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).not.toContain('/Artifact');
  });

  it('bails to struct-tree-level handling when the ambient fill color to preserve cannot be determined', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // No color op inside the run's own text object, and the last color op
    // before it (0.5 scn) uses a colorspace findPrecedingColor can't parse
    // (its own doc comment: any sc/scn always resolves to "unknown").
    const noParseableColor = `0.5 scn\n/Figure <</MCID 0>>BDC\nBT\n/F1 8 Tf\n1 0 0 1 250 493 Tm\n<4539343732> Tj\nET\nEMC\n`;
    writePageContent(doc, 1, noParseableColor);

    const results = await pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('ambient fill color');
    expect(results[0].error).toContain('struct-tree-level handling');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).not.toContain('/Artifact');
  });
});
