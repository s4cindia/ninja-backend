import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { countStructureElements } from '../../../../src/services/pdf/adobe-autotag.service';

async function buildTaggedPdf(types: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const kidRefs = types.map((type) => doc.context.register(doc.context.obj({ S: PDFName.of(type), K: 0 })));
  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj(kidRefs) })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return Buffer.from(await doc.save());
}

describe('adobe-autotag.service — countStructureElements', () => {
  it('counts bare "H" and H1-H9 as headings, but not "H0" -- not a valid PDF/UA structure type', async () => {
    const buffer = await buildTaggedPdf(['H', 'H1', 'H9', 'H0', 'P']);
    const counts = await countStructureElements(buffer);

    expect(counts.headings).toBe(3); // H, H1, H9 -- H0 excluded
    expect(counts.paragraphs).toBe(1);
  });
});
