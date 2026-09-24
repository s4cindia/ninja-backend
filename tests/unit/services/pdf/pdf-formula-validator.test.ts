import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString } from 'pdf-lib';
import { pdfFormulaValidator } from '../../../../src/services/pdf/validators/pdf-formula.validator';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';

// The validator only touches parsedPdf.pdfLibDoc.
const asParsed = (doc: PDFDocument): ParsedPDF => ({ pdfLibDoc: doc } as unknown as ParsedPDF);

async function taggedWithFormula(): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText('E = mc2', { x: 100, y: 450, size: 14, font }); // baseline 450
  // reload so the drawn content is flushed into a real content stream
  const doc = await PDFDocument.load(await src.save());
  // formula zone covering the text (device band [420,480] ∋ 450; x [80,320] ∋ 100)
  const zones: OrderableZone[] = [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }];
  buildStructTreeFromZones(doc, zones);
  return doc;
}

describe('pdfFormulaValidator', () => {
  it('flags a Formula element with no ActualText and emits an MCID-exact, applyable id', async () => {
    const doc = await taggedWithFormula();

    const res = await pdfFormulaValidator.validate(asParsed(doc));
    expect(res.metadata.totalFormulas).toBe(1);
    expect(res.issues).toHaveLength(1);

    const issue = res.issues[0];
    expect(issue.code).toBe('FORMULA-MISSING-ACTUALTEXT');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toMatch(/^formula_p1_mc\d+$/);
    // region bbox recovered from the /A /Layout /BBox (top-left origin)
    expect(issue.boundingBox).toBeTruthy();
    expect(issue.boundingBox!.width).toBeCloseTo(240, 5);
    expect(issue.boundingBox!.height).toBeCloseTo(60, 5);
    expect(issue.boundingBox!.x).toBeCloseTo(80, 5);
    expect(issue.boundingBox!.y).toBeCloseTo(120, 5); // top-left y == original zone y

    // the emitted id is precisely what the apply primitive targets
    const apply = await pdfModifierService.setActualText(doc, issue.element!, 'E equals m c squared');
    expect(apply.success).toBe(true);

    // re-running the validator now sees the alternate and reports clean
    const after = await pdfFormulaValidator.validate(asParsed(doc));
    expect(after.issues).toHaveLength(0);
    expect(after.metadata.formulasWithAlternate).toBe(1);
  });

  it('treats a hex-encoded (PDFHexString) ActualText as a valid alternate', async () => {
    const doc = await taggedWithFormula();
    // set ActualText directly as a hex string (as some authoring tools do)
    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    const setHexOnFormula = (n: unknown): void => {
      if (!(n instanceof PDFDict)) return;
      if (n.get(PDFName.of('S'))?.toString() === '/Formula') {
        n.set(PDFName.of('ActualText'), PDFHexString.fromText('E equals m c squared'));
      }
      const k = n.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) setHexOnFormula(doc.context.lookup(kid));
    };
    setHexOnFormula(root);

    const res = await pdfFormulaValidator.validate(asParsed(doc));
    expect(res.metadata.totalFormulas).toBe(1);
    expect(res.metadata.formulasWithAlternate).toBe(1);
    expect(res.issues).toHaveLength(0);
  });

  it('is a no-op on a PDF with no structure tree', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const res = await pdfFormulaValidator.validate(asParsed(doc));
    expect(res.issues).toHaveLength(0);
    expect(res.metadata.totalFormulas).toBe(0);
  });

  // /Pg is inheritable per PDF32000-1:2008 §14.7.2 -- a struct element with
  // no /Pg of its own takes its nearest ancestor's. Real incident on
  // Math_Nikitopoulos_PDF.pdf: Seam-C stamps /Pg on an ancestor Sect, not on
  // the /Formula node itself, and the old code only ever checked the
  // Formula's OWN /Pg -- silently defaulting to page 1 with no boundingBox.
  // dispatchIssue's own gate (`if (!issue.pageNumber || !parsed.parsedPdf ||
  // !issue.boundingBox) return null`) then refused to generate ANY
  // suggestion for it at all, on every Auto Mode round.
  it('REGRESSION: resolves pageNumber/boundingBox from an ancestor /Pg when the Formula element has none of its own', async () => {
    const src = await PDFDocument.create();
    src.addPage([400, 600]);
    src.addPage([400, 600]);
    const doc = await PDFDocument.load(await src.save());
    const pages = doc.getPages();
    const page2Ref = pages[1].ref;

    const formulaDict = doc.context.obj({ S: PDFName.of('Formula'), K: 0 });
    const formulaRef = doc.context.register(formulaDict);
    // Ancestor Sect declares /Pg -- the Formula itself does not.
    const sectDict = doc.context.obj({ S: PDFName.of('Sect'), Pg: page2Ref, K: formulaRef });
    const sectRef = doc.context.register(sectDict);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: sectRef });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const res = await pdfFormulaValidator.validate(asParsed(doc));
    expect(res.issues).toHaveLength(1);
    const issue = res.issues[0];
    expect(issue.pageNumber).toBe(2);
    expect(issue.element).toBe('formula_p2_mc0');
  });
});
