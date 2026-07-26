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
});
