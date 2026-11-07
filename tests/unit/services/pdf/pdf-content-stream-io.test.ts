import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decodePageContent, writePageContent, pageContentMcids, orderedPageContentMcids } from '../../../../src/services/pdf/pdf-content-stream-io';

// Regression coverage for the exact decode/write logic previously inlined in
// pdf-modifier.service.ts's private decodePageContent — that method now
// delegates here, so this test locks the behavior both share.

async function realPdf(): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText('Hello world', { x: 50, y: 500, size: 14, font });
  // save + reload so the text draw is flushed into a real, loadable content stream
  return PDFDocument.load(await src.save());
}

describe('decodePageContent', () => {
  it('decodes a real content stream to a latin1 string containing the page operators', async () => {
    const doc = await realPdf();
    const content = decodePageContent(doc, 1);
    expect(content).toBeTruthy();
    expect(content).toContain('Tj'); // text-show operator from drawText
    expect(content).toContain('BT');
    expect(content).toContain('ET');
  });

  it('returns null for an out-of-range page rather than throwing', async () => {
    const doc = await realPdf();
    expect(decodePageContent(doc, 99)).toBeNull();
  });
});

describe('writePageContent', () => {
  it('round-trips: content written back is what gets decoded next', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    const modified = original + '\n% a harmless comment appended for this test\n';

    writePageContent(doc, 1, modified);

    const reDecoded = decodePageContent(doc, 1);
    expect(reDecoded).toBe(modified);
  });

  it('survives a save/reload cycle (the new stream is really persisted, not just in-memory)', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    const appended = original + '\nq 1 0 0 RG 0 0 10 10 re S Q\n';

    writePageContent(doc, 1, appended);
    const reloaded = await PDFDocument.load(await doc.save());

    const finalContent = decodePageContent(reloaded, 1);
    expect(finalContent).toContain('1 0 0 RG');
    expect(finalContent).toContain('Tj'); // original text-show operator preserved
  });
});

describe('pageContentMcids', () => {
  it('collects every MCID opened via a plain << /MCID n >> BDC', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/P << /MCID 3 >> BDC\nq Q\nEMC\n/P << /MCID 5 >> BDC\nq Q\nEMC\n`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set([3, 5]));
  });

  /**
   * CodeRabbit finding on PR #531: the original regex only matched a BDC
   * property dict containing /MCID as its sole entry -- a real, valid
   * sequence like `<< /Lang (en-US) /MCID 7 >> BDC` (other keys alongside
   * /MCID, e.g. a language override) would silently fail to match, making
   * the page-resolution fallback wrongly reject an element that genuinely
   * belongs to the target page.
   */
  it('collects an MCID from a BDC property dict that carries other keys alongside /MCID', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Span << /Lang (en-US) /MCID 7 /Alt (a note) >> BDC\nq Q\nEMC\n`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set([7]));
  });

  it('ignores a BDC with no /MCID at all (e.g. an Artifact/OC property dict)', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/OC << /Name (Layer1) >> BDC\nq Q\nEMC\n`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set());
  });

  it('returns null for an out-of-range page rather than throwing', async () => {
    const doc = await realPdf();
    expect(pageContentMcids(doc, 99)).toBeNull();
  });

  /**
   * Real, load-bearing bug found live on Karsaklian_189165_9781606497623
   * (2026-11-07): a dict ending in a nested `<...>` HEX STRING immediately
   * followed by the dict's own closing `>>` -- e.g.
   * `<</MCID 7 /ActualText<FEFF0041>>>` -- produces three consecutive `>`
   * characters. The naive "any char not followed by >>" loop stopped one
   * character too early (right before the hex string's OWN closing `>`,
   * since the lookahead saw '>>' starting there), then failed to match the
   * required literal `>>` immediately after (what's actually there is a
   * THIRD `>`) -- silently dropping the whole BDC occurrence, MCID
   * included. Confirmed real: this exact shape is how InDesign encodes a
   * multi-byte /ActualText value, and once a real /MCID got written into
   * one of these dicts (pdf-structure-writer.service.ts's own
   * fixActualTextMissingMcid, PR #781), this function's own undercount of
   * "next available MCID" collided with /ParentTree's real, already-
   * correct entry count, causing a real downstream extendParentTree
   * contiguity failure on an unrelated fixer (buildFigureFromImage) that
   * merely happened to run on the same page afterward.
   */
  it('collects an MCID from a dict ending in a nested hex-string value immediately followed by the dict\'s own closing ">>"', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Span<</MCID 7 /ActualText<FEFF0041>>> BDC\n(A)Tj\nEMC\n`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set([7]));
  });

  it('collects MCIDs from several consecutive hex-ActualText dicts in a row (the real running-header shape)', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    const run =
      '/Span<</MCID 7 /ActualText<FEFF0041>>> BDC\n(A)Tj\nEMC ' +
      '/Span<</MCID 8 /ActualText<FEFF0042>>> BDC\n(B)Tj\nEMC\n';
    writePageContent(doc, 1, `${original}\n${run}`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set([7, 8]));
  });

  it('still correctly stops at the dict\'s own close when a hex string is followed by MORE dict entries, not just the close', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Span<</ActualText<FEFF0041> /MCID 9>> BDC\n(A)Tj\nEMC\n`);

    expect(pageContentMcids(doc, 1)).toEqual(new Set([9]));
  });
});

describe('orderedPageContentMcids', () => {
  it('returns MCIDs in document order with their own byte offsets, including the hex-ActualText shape', () => {
    const content = '/Span<</MCID 7 /ActualText<FEFF0041>>> BDC\n(A)Tj\nEMC /P <</MCID 8>> BDC\n(B)Tj\nEMC\n';
    const result = orderedPageContentMcids(content);
    expect(result.map((r) => r.mcid)).toEqual([7, 8]);
    expect(result[0].start).toBe(content.indexOf('<<'));
    expect(result[1].start).toBeGreaterThan(result[0].start);
  });
});
