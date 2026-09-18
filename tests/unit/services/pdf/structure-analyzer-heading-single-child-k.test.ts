/**
 * Regression coverage for structureAnalyzerService's tagged-heading
 * extraction (extractTaggedHeadings / traverseStructureTree).
 *
 * Real incident, Math_Weir_PDF.pdf (a 377-page tagged textbook):
 * /StructTreeRoot's own /K is a bare single ref, not wrapped in a 1-element
 * array -- entirely legal PDF (PDF32000-1:2008 §14.7.2 permits a single
 * child to be stored bare), and in fact how 79% of this real document's
 * 33,724 structure elements store their own single child. traverseStructureTree
 * only ever recursed into `kids instanceof PDFArray`, so it stopped dead at
 * the very first level -- extractTaggedHeadings found ZERO tagged headings
 * on a document that has hundreds of real, correctly-tagged ones, silently
 * falling back to the font-size/text heuristic for every heading instead.
 * Meant fixHeadingHierarchy/fixMultipleH1's own structure-tree writes
 * (renaming elements to close real heading-hierarchy gaps) had no way to
 * ever be reflected back by a re-audit: the audit's own heading detector
 * never looked at the tag tree it had just been fixed.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { structureAnalyzerService } from '../../../../src/services/pdf/structure-analyzer.service';

async function buildPage(doc: PDFDocument): Promise<void> {
  const page = doc.addPage([400, 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Some page content', { x: 60, y: 500, size: 12, font, color: rgb(0, 0, 0) });
}

describe('structureAnalyzerService — tagged-heading extraction with bare (non-array) /K', () => {
  it('finds tagged H1/H2 elements reached only through single-child (bare-ref) /K nodes, including at /StructTreeRoot itself', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    // Mirrors the real incident's shape: EVERY level down to the headings
    // themselves uses a bare single child, not a 1-element array --
    // including /StructTreeRoot's own /K, the actual root-level failure.
    const h1Dict = doc.context.obj({ S: PDFName.of('H1'), K: 0 });
    const h1Ref = doc.context.register(h1Dict);
    const sectDict = doc.context.obj({ S: PDFName.of('Sect'), K: h1Ref }); // bare ref, not [h1Ref]
    const sectRef = doc.context.register(sectDict);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: sectRef }); // bare ref
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef }); // bare ref
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'bare-k-heading.pdf');

    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    const fromTags = headingHierarchy.headings.filter(h => h.isFromTags);
    expect(fromTags.length).toBe(1);
    expect(fromTags[0].level).toBe(1);
  });

  it('finds every heading in a tree that mixes array and bare-single /K at different levels', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const h1Dict = doc.context.obj({ S: PDFName.of('H1'), K: 0 });
    const h1Ref = doc.context.register(h1Dict);
    const h2Dict = doc.context.obj({ S: PDFName.of('H2'), K: 1 });
    const h2Ref = doc.context.register(h2Dict);

    // Sect1 has ONE child (bare ref) containing H1; Sect2 has ONE child too
    // (bare ref) containing H2 -- but Document itself has TWO children
    // (Sect1, Sect2), so /Document's own /K IS a real array. Confirms the
    // fix handles both shapes correctly at once, not just an all-bare tree.
    const sect1Dict = doc.context.obj({ S: PDFName.of('Sect'), K: h1Ref });
    const sect1Ref = doc.context.register(sect1Dict);
    const sect2Dict = doc.context.obj({ S: PDFName.of('Sect'), K: h2Ref });
    const sect2Ref = doc.context.register(sect2Dict);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([sect1Ref, sect2Ref]) });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'mixed-k-heading.pdf');

    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    const fromTags = headingHierarchy.headings.filter(h => h.isFromTags);
    expect(fromTags.map(h => h.level).sort()).toEqual([1, 2]);
  });

  /**
   * Real Math_Weir_PDF.pdf incident, part 2: even after the single-child-/K
   * fix above let the traversal actually reach every element, the very
   * chapter-title heading that fixMultipleH1 deliberately leaves under its
   * ORIGINAL custom role name (only the H1s AFTER the first ever get
   * demoted/renamed -- see pdf-structure-writer.service.ts's fixMultipleH1)
   * was still invisible to this same /^\/H[1-6]?$/ literal-tag check --
   * this module has its own independent copy of the RoleMap-blindness bug
   * fixHeadingHierarchy/fixMultipleH1 already fix on the writer side. Net
   * effect on the real document: "Document has no H1 heading" got reported
   * even though a real, correctly-tagged H1 (role-mapped as /cptitle) was
   * sitting right there.
   */
  it('recognizes a heading tagged with a custom role name the /RoleMap maps to Hn', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc);

    const roleMapRef = doc.context.register(doc.context.obj({ cptitle: PDFName.of('H1') }));
    const h1Dict = doc.context.obj({ S: PDFName.of('cptitle'), K: 0 });
    const h1Ref = doc.context.register(h1Dict);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: h1Ref });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({
      Type: PDFName.of('StructTreeRoot'),
      RoleMap: roleMapRef,
      K: documentRef,
    });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'rolemap-h1.pdf');

    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    expect(headingHierarchy.hasH1).toBe(true);
    const fromTags = headingHierarchy.headings.filter(h => h.isFromTags);
    expect(fromTags).toHaveLength(1);
    expect(fromTags[0].level).toBe(1);
  });
});
