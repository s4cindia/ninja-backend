import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';

/**
 * Regression coverage for a real bug found on a live document (Army trial,
 * 2026-09-19): writePdfUaIdentifier reported success, but the saved PDF
 * never contained "pdfuaid" anywhere. Root cause: real-world XMP commonly
 * has MULTIPLE sibling <rdf:Description> elements under <rdf:RDF> (one per
 * namespace group -- routine for Adobe-exported PDFs), which fast-xml-parser
 * represents as an array. The old code assumed a single object and did
 * `desc[key] = value` unconditionally -- on an array, that sets a
 * non-index string property XMLBuilder silently drops on re-serialization.
 */

async function setRawXmp(doc: PDFDocument, xml: string): Promise<void> {
  const bytes = Buffer.from(xml, 'utf8');
  const stream = doc.context.stream(bytes, {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
    Length: bytes.length,
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
}

function readRawXmp(doc: PDFDocument): string {
  const ref = doc.catalog.get(PDFName.of('Metadata'));
  const raw = doc.context.lookup(ref!);
  if (!(raw instanceof PDFRawStream)) throw new Error('Metadata is not a raw stream');
  return Buffer.from(raw.contents).toString('utf8');
}

const MULTI_DESCRIPTION_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>2025-09-10T15:35:06+05:30</xmp:CreateDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Adobe PDF Library 17.0</pdf:Producer>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const SINGLE_DESCRIPTION_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>2025-09-10T15:35:06+05:30</xmp:CreateDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe('writePdfUaIdentifier / writeXmpStream', () => {
  it('writes pdfuaid:part when there is no existing metadata stream at all (Path A)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('pdfuaid:part');
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
  });

  it('writes pdfuaid:part into a SINGLE existing rdf:Description with a proper namespace declaration', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, SINGLE_DESCRIPTION_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    // Original content must survive the patch, not be replaced.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
  });

  it('REGRESSION: writes pdfuaid:part when rdf:Description is an ARRAY (multiple sibling elements) -- the real bug', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, MULTI_DESCRIPTION_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    // Before the fix, this failed: the identifier was silently dropped on
    // re-serialization even though writePdfUaIdentifier reported success.
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    // Both original descriptions must survive untouched.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
    expect(xmp).toContain('Adobe PDF Library 17.0');
  });

  it('REGRESSION: survives a doc.save() round trip with a multi-description XMP (the exact real-world symptom)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, MULTI_DESCRIPTION_XMP);

    await pdfModifierService.writePdfUaIdentifier(doc);
    const savedBytes = Buffer.from(await doc.save());

    expect(savedBytes.toString('latin1')).toContain('pdfuaid');
  });
});
