import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';

function countMetadataObjects(doc: PDFDocument): number {
  let count = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict?.get(PDFName.of('Type'))?.toString() === '/Metadata') count++;
  }
  return count;
}

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

// CodeRabbit's own example on PR #605: a valid XMP packet is free to use any
// namespace prefix alias, not just the conventional x:/rdf:.
const NONSTANDARD_PREFIX_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<meta:xmpmeta xmlns:meta="adobe:ns:meta/">
  <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <r:Description r:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>2025-09-10T15:35:06+05:30</xmp:CreateDate>
    </r:Description>
  </r:RDF>
</meta:xmpmeta>
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

  it('REGRESSION: does not append a new rdf:Description on a REPEAT call once one already declares the patched namespace -- real incident (Nikitopoulos trial, 2026-09-25): the same document accumulated 9 redundant <rdf:Description xmlns:pdfuaid=...> blocks across repeated Auto Mode rounds', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, MULTI_DESCRIPTION_XMP);

    await pdfModifierService.writePdfUaIdentifier(doc);
    await pdfModifierService.writePdfUaIdentifier(doc);
    await pdfModifierService.writePdfUaIdentifier(doc);

    const xmp = readRawXmp(doc);
    const descriptionCount = (xmp.match(/<rdf:Description\b/g) ?? []).length;
    // 2 original (xmp:, pdf:) + exactly 1 new one for pdfuaid -- not 4.
    expect(descriptionCount).toBe(3);
    const pdfuaidCount = (xmp.match(/<pdfuaid:part>1<\/pdfuaid:part>/g) ?? []).length;
    expect(pdfuaidCount).toBe(1);
    // Both original descriptions still survive untouched.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
    expect(xmp).toContain('Adobe PDF Library 17.0');
  });

  // CodeRabbit finding on this same PR, confirmed real: a valid RDF/XML
  // document can have an empty/self-closing sibling <rdf:Description/>,
  // which fast-xml-parser represents as a bare '' string in the array, not
  // an object. The dedup fix's own `in` check would throw on that, and the
  // enclosing catch would treat the WHOLE stream as unparseable -- silently
  // deleting every real metadata field via the template fallback.
  const EMPTY_SIBLING_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description/>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>2025-09-10T15:35:06+05:30</xmp:CreateDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  it('REGRESSION: does not throw (and does not fall back to the template) when a sibling rdf:Description is empty/self-closing', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, EMPTY_SIBLING_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    // The template fallback would have DELETED this -- its survival proves
    // the real (non-template) patch path ran successfully.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
  });

  // CodeRabbit finding on this same PR, confirmed real: matching on the
  // xmlns ATTRIBUTE KEY alone (ignoring its value) could select a
  // description that binds the same lexical prefix to a DIFFERENT,
  // non-canonical URI -- writing the patch there would report success
  // while landing in the wrong namespace entirely. Same bug class existed
  // in BOTH the single-Description branch (fixed alongside the array
  // branch, since it's the identical pattern sitting right next to it) and
  // the array branch (a genuine sibling-selection bug).
  const WRONG_NAMESPACE_URI_SINGLE_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://example.com/not-the-real-pdfuaid-ns/">
      <pdfuaid:bogus>1</pdfuaid:bogus>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  it('REGRESSION: promotes to a second sibling rather than corrupting a SINGLE existing Description that binds the same prefix to a different URI', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, WRONG_NAMESPACE_URI_SINGLE_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // The bogus description's own wrong-namespace declaration and content
    // survive untouched -- proving pdfuaid:part was NOT written into it.
    expect(xmp).toContain('xmlns:pdfuaid="http://example.com/not-the-real-pdfuaid-ns/"');
    expect(xmp).toContain('<pdfuaid:bogus>1</pdfuaid:bogus>');
  });

  const WRONG_NAMESPACE_URI_ARRAY_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>2025-09-10T15:35:06+05:30</xmp:CreateDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://example.com/not-the-real-pdfuaid-ns/">
      <pdfuaid:bogus>1</pdfuaid:bogus>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  it('REGRESSION: creates a NEW correctly-namespaced sibling rather than reusing an ARRAY sibling that binds the same prefix to a different URI', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, WRONG_NAMESPACE_URI_ARRAY_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // The bogus sibling's own wrong-namespace declaration and content, plus
    // the unrelated xmp: sibling, survive untouched.
    expect(xmp).toContain('xmlns:pdfuaid="http://example.com/not-the-real-pdfuaid-ns/"');
    expect(xmp).toContain('<pdfuaid:bogus>1</pdfuaid:bogus>');
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
  });

  it('REGRESSION: declares xmlns:dc when deriveAndSetTitle patches dc:title into a multi-description document', async () => {
    // Codex + CodeRabbit finding on this same PR, confirmed real: the first
    // version of namespaceUri only knew 'pdfuaid' -- deriveAndSetTitle's own
    // dc:title patch would hit the exact same array branch and append
    // <dc:title> with no xmlns:dc declared anywhere, since none of the
    // MULTI_DESCRIPTION_XMP fixture's existing descriptions declare `dc`
    // either (only xmp: and pdf:).
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, MULTI_DESCRIPTION_XMP);

    await pdfModifierService.writeXmpStream(doc, { 'dc:title': 'A Real Title' });

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<dc:title>A Real Title</dc:title>');
    expect(xmp).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    // Both original descriptions must survive untouched.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
    expect(xmp).toContain('Adobe PDF Library 17.0');
  });

  // CodeRabbit finding on this same PR, confirmed real: dc:title is
  // conventionally structured as <dc:title><rdf:Alt><rdf:li
  // xml:lang="x-default">...</rdf:li></rdf:Alt></dc:title> -- confirmed on
  // the real Math_Nikitopoulos_PDF.pdf XMP -- not a plain string. The dedup
  // fix's own `target[key] = value` would replace the whole rdf:Alt
  // structure with a bare string, silently dropping any OTHER language
  // alternative a real document might carry.
  const EXISTING_ALT_TITLE_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">Old Title</rdf:li>
          <rdf:li xml:lang="fr">Ancien Titre</rdf:li>
        </rdf:Alt>
      </dc:title>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  it('REGRESSION: updates the x-default rdf:li in place rather than replacing the whole rdf:Alt container when dc:title already exists', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, EXISTING_ALT_TITLE_XMP);

    await pdfModifierService.writeXmpStream(doc, { 'dc:title': 'New Title' });

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<rdf:li xml:lang="x-default">New Title</rdf:li>');
    // The other language alternative must survive untouched -- proving the
    // rdf:Alt container itself was updated in place, not replaced.
    expect(xmp).toContain('<rdf:li xml:lang="fr">Ancien Titre</rdf:li>');
    expect(xmp).not.toContain('Old Title');
    expect(xmp).not.toContain('<dc:title>New Title</dc:title>');
  });

  it('REGRESSION: survives a doc.save() round trip with a multi-description XMP (the exact real-world symptom)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, MULTI_DESCRIPTION_XMP);

    await pdfModifierService.writePdfUaIdentifier(doc);
    const savedBytes = Buffer.from(await doc.save());

    expect(savedBytes.toString('latin1')).toContain('pdfuaid');
  });

  it('REGRESSION: recognizes x:xmpmeta/rdf:RDF by namespace URI, not literal prefix -- CodeRabbit finding on this same PR: a valid packet using different prefixes (e.g. meta:xmpmeta/r:RDF) must NOT be misclassified as unparseable, which would delete its real metadata via the template fallback', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    await setRawXmp(doc, NONSTANDARD_PREFIX_XMP);

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // The original content must survive -- if this had been wrongly
    // classified as unparseable, the template fallback would have deleted
    // it entirely.
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
  });

  it('REGRESSION: falls back to the template (rather than silently no-op-ing) when the existing metadata is unparseable garbage -- root cause of a real bug (Nikitopoulos trial, 2026-09-24): writePdfUaIdentifier reported success on every one of 10 real Auto Mode rounds, but the on-disk XMP never changed', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    // fast-xml-parser does not throw on non-XML input -- it silently returns
    // a degenerate object with no x:xmpmeta/rdf:RDF anywhere. Before the fix,
    // that fell through as a "successful" no-op: patches were silently never
    // applied, yet the same garbage got rebuilt and written straight back.
    const bytes = Buffer.from([0x3c, 0x32, 0x6e, 0xef, 0xbf, 0xbd, 0x01, 0xef, 0xbf, 0xbd, 0x31]);
    const stream = doc.context.stream(bytes, {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
      Length: bytes.length,
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const xmp = readRawXmp(doc);
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(xmp).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
  });

  it('REGRESSION: decompresses a FlateDecode-compressed existing metadata stream before parsing, instead of reading the raw encoded bytes as UTF-8', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const compressed = doc.context.flateStream(Buffer.from(SINGLE_DESCRIPTION_XMP, 'utf8'), {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(compressed));

    const result = await pdfModifierService.writePdfUaIdentifier(doc);
    expect(result.success).toBe(true);

    const ref = doc.catalog.get(PDFName.of('Metadata'));
    const raw = doc.context.lookup(ref!);
    if (!(raw instanceof PDFRawStream)) throw new Error('Metadata is not a raw stream');
    const xmp = Buffer.from(decodePDFRawStream(raw).decode()).toString('utf8');

    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // Original content must survive the patch, not be replaced by a
    // template fallback (which would mean decompression silently failed).
    expect(xmp).toContain('2025-09-10T15:35:06+05:30');
  });

  // Real incident, Math_Nikitopoulos_PDF.pdf (2026-09-25): every call
  // registers a brand-new /Metadata stream object and repoints the catalog
  // to it, but never removed the object it superseded. Across a real
  // document's full remediation history this left 10 separate /Type
  // /Metadata objects permanently embedded in the file -- only the newest
  // referenced by the catalog, the other 9 pure dead weight that grows by
  // one every time the fix (harmlessly, from Ninja's own perspective) keeps
  // re-running.
  it('REGRESSION: deletes the superseded /Metadata object instead of leaving it as permanent dead weight in the file', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    expect(countMetadataObjects(doc)).toBe(0);
    await pdfModifierService.writePdfUaIdentifier(doc);
    expect(countMetadataObjects(doc)).toBe(1);
    await pdfModifierService.writePdfUaIdentifier(doc);
    await pdfModifierService.writePdfUaIdentifier(doc);
    // 3 total calls, but still only ONE /Metadata object should exist --
    // each call's own object superseded (and deleted) the previous one.
    expect(countMetadataObjects(doc)).toBe(1);

    const savedBytes = Buffer.from(await doc.save());
    const reloaded = await PDFDocument.load(savedBytes, { updateMetadata: false });
    expect(countMetadataObjects(reloaded)).toBe(1);
  });

  // CodeRabbit finding on this same PR, confirmed real: PDF permits
  // page-level metadata (a page's own /Metadata key, independent of the
  // document-level one) -- if it happens to point at the SAME object the
  // catalog's own /Metadata just referenced, unconditionally deleting that
  // object would leave the page's reference dangling, and doc.save() would
  // write a malformed PDF with no object for it.
  it('REGRESSION: does not delete the superseded object when a page still references it via its own /Metadata key', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);

    await pdfModifierService.writePdfUaIdentifier(doc);
    expect(countMetadataObjects(doc)).toBe(1);

    // Simulate a page that happens to share the SAME metadata object the
    // catalog currently references.
    const sharedRef = doc.catalog.get(PDFName.of('Metadata'));
    page.node.set(PDFName.of('Metadata'), sharedRef!);

    await pdfModifierService.writePdfUaIdentifier(doc);
    // The catalog now points to a NEW object, but the OLD (shared) one must
    // survive -- the page still references it.
    expect(countMetadataObjects(doc)).toBe(2);
    expect(page.node.get(PDFName.of('Metadata'))?.toString()).toBe(sharedRef!.toString());

    // Must also survive a real save+reload, not just stay valid in memory.
    const savedBytes = Buffer.from(await doc.save());
    const reloaded = await PDFDocument.load(savedBytes, { updateMetadata: false });
    expect(countMetadataObjects(reloaded)).toBe(2);
  });
});
