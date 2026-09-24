/**
 * Regression coverage for a real false-positive HEADING-SKIP bug
 * (Math_Nikitopoulos_PDF.pdf trial, 2026-09-24).
 *
 * analyzeHeadings() unconditionally re-sorted ALL headings by
 * (pageNumber, position.y) after populating them from extractTaggedHeadings
 * -- but tag-tree-derived headings are already in the struct tree's own
 * K-array order, the authoritative PDF/UA reading order, and
 * extractTaggedHeadings always hardcodes position.y to 0 for them (it has
 * no real position data), so that secondary sort key was already a no-op.
 *
 * On the real document, two headings (H3 and H6) had their /Pg
 * unresolvable anywhere in their own ancestor chain and silently defaulted
 * to the traversal's seed page (1), while the two headings genuinely
 * between them in true reading order (H4, H5) correctly resolved to a real,
 * later page. The (pageNumber, ...) sort then grouped the two
 * wrongly-page-1 headings adjacent to each other, severing them from their
 * correctly-resolved neighbors and fabricating an "H3 to H6" skipped-level
 * issue that never exists in the tag tree's own order -- confirmed via the
 * writer's own traversal (pdf-structure-writer.service.ts's
 * fixHeadingHierarchy, which never sorts), finding zero real skips in the
 * same sequence.
 *
 * Fix: skip the (pageNumber, position.y) sort entirely for tag-tree-derived
 * headings -- it can only ever scramble an already-correct order, never fix
 * one. The sort is still needed (and unchanged) for the font-size/text
 * heuristic path, which has no real tags and genuinely needs a position-
 * based order.
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

describe('structureAnalyzerService — heading order must never be re-sorted by an unreliable page number', () => {
  it('REGRESSION: does not fabricate a skipped-level issue when two headings with unresolvable /Pg default to the seed page, sandwiching two correctly-paged headings in between', async () => {
    const doc = await PDFDocument.create();
    await buildPage(doc); // page 1 (the traversal's seed page)
    await buildPage(doc); // page 2 (resolvable via its own /Pg)

    const pages = doc.getPages();
    const page2Ref = pages[1].ref;

    // H3 and H6: no /Pg anywhere in their own dict -- unresolvable, so they
    // inherit whatever page the traversal was seeded with (1), exactly like
    // the real document's two mis-resolved headings.
    const h3Dict = doc.context.obj({ S: PDFName.of('H3'), K: 0 });
    const h3Ref = doc.context.register(h3Dict);

    // H4 and H5: DO declare a real, resolvable /Pg (page 2) -- like the two
    // real headings that sat correctly between the mis-resolved pair in
    // true reading order.
    const h4Dict = doc.context.obj({ S: PDFName.of('H4'), K: 1, Pg: page2Ref });
    const h4Ref = doc.context.register(h4Dict);
    const h5Dict = doc.context.obj({ S: PDFName.of('H5'), K: 2, Pg: page2Ref });
    const h5Ref = doc.context.register(h5Dict);

    const h6Dict = doc.context.obj({ S: PDFName.of('H6'), K: 3 });
    const h6Ref = doc.context.register(h6Dict);

    // True reading order: H3 -> H4 -> H5 -> H6, a perfectly valid hierarchy
    // (each step increases by exactly one level) -- the exact shape that
    // must never be reported as a skip, regardless of how /Pg resolves.
    const documentDict = doc.context.obj({
      S: PDFName.of('Document'),
      K: doc.context.obj([h3Ref, h4Ref, h5Ref, h6Ref]),
    });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'heading-page-sort-scramble.pdf');

    const headingHierarchy = await structureAnalyzerService.getHeadingsOnly(parsedPdf);

    const fromTags = headingHierarchy.headings.filter(h => h.isFromTags);
    expect(fromTags.map(h => h.level)).toEqual([3, 4, 5, 6]);

    const skips = headingHierarchy.issues.filter(i => i.type === 'skipped-level');
    expect(skips).toEqual([]);
  });
});
