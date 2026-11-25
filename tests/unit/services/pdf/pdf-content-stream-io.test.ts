import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import {
  decodePageContent,
  writePageContent,
  pageContentMcids,
  orderedPageContentMcids,
  mcidHasImageOrVectorContent,
  extractMcidText,
} from '../../../../src/services/pdf/pdf-content-stream-io';

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

  // Real, confirmed incident (WPVP_180188_9798986469300_txt.pdf, 2026-11-10):
  // a /Contents array whose boundary falls right between a /Tf operator and
  // the tag that needs it glued the two segments' adjacent tokens into one
  // unrecognized token when concatenated with no separator -- silently
  // losing the font-selection operator from that point on. PDF32000 §7.8.2
  // guarantees each array element is internally a complete token sequence,
  // but says nothing about whitespace AT the boundary, so this is a real,
  // legal shape a conforming producer can emit.
  it('inserts a newline between /Contents array elements, so a token split across the boundary (no trailing/leading whitespace on either side) decodes as two separate tokens, not one glued one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);

    // Segment 1 ends with "Tf" (no trailing whitespace); segment 2 begins
    // with "BMC" (no leading whitespace) -- naive concatenation would glue
    // them into the single, unrecognized token "TfBMC".
    const seg1 = doc.context.register(doc.context.stream('/F1 12 Tf'));
    const seg2 = doc.context.register(doc.context.stream('BMC'));
    page.node.set(PDFName.of('Contents'), doc.context.obj([seg1, seg2]));

    const content = decodePageContent(doc, 1)!;
    expect(content).toContain('Tf');
    expect(content).toContain('BMC');
    expect(content).not.toContain('TfBMC');
    // The two segments are joined by exactly one inserted newline -- not
    // reproducing any original formatting that genuinely wasn't there, the
    // minimum needed to keep the boundary tokens apart.
    expect(content).toBe('/F1 12 Tf\nBMC');
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

describe('mcidHasImageOrVectorContent / extractMcidText -- nested marked content exclusion', () => {
  it('detects direct image/vector/text content under an mcid with no nesting at all', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Figure <</MCID 10>> BDC\nq 0 0 10 10 re f Q\n(hello)Tj\nEMC\n`);
    const content = decodePageContent(doc, 1)!;

    expect(mcidHasImageOrVectorContent(content, 10)).toBe(true);
    expect(extractMcidText(content, 10)).toBe('hello');
  });

  /**
   * Real bug, 2026-11-25 (T4's own page-90 Figure, MCID 8): the outer
   * Figure opens, then immediately opens a nested `/Artifact BMC` whose
   * matching EMC doesn't appear until AFTER a real image Do and a page's
   * worth of vector-art strokes. measure.py's own _state() correctly
   * attributes all of that to the nested Artifact, not the outer Figure
   * (Artifact content is never part of the accessible structure) --
   * which is how this Figure was confirmed "empty" despite visibly
   * containing an image and vector paint. Before this fix,
   * mcidHasImageOrVectorContent/extractMcidText scanned the WHOLE outer
   * span including nested regions, reporting "has content" for a Figure
   * with nothing actually exposed as its own -- which then got sent to
   * vision for alt text and hallucinated a description for a region with
   * nothing real to look at.
   */
  it('excludes drawing and text nested inside a child /Artifact span, even when that Artifact\'s own EMC is positioned late (after the real content)', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(
      doc,
      1,
      `${original}\n/Figure <</MCID 8>> BDC\nq 357 11 224 306 re W n\n/Artifact BMC\n(credit line)Tj\nq 1 0 0 1 0 0 cm 0 0 m 10 10 l S Q\n/Im0 Do\nEMC\nQ\nEMC\n`
    );
    const content = decodePageContent(doc, 1)!;

    expect(mcidHasImageOrVectorContent(content, 8)).toBe(false);
    expect(extractMcidText(content, 8)).toBe('');
  });

  it('excludes content nested inside a child struct element (another real MCID), attributing it only to the inner one', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Figure <</MCID 6>> BDC\n/Figure <</MCID 4>> BDC\n/Im0 Do\nEMC\nEMC\n`);
    const content = decodePageContent(doc, 1)!;

    expect(mcidHasImageOrVectorContent(content, 6)).toBe(false);
    expect(mcidHasImageOrVectorContent(content, 4)).toBe(true);
  });

  it('still finds direct content that comes AFTER a nested span closes, within the same outer mcid', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/Figure <</MCID 11>> BDC\n/Artifact BMC\n(stamp)Tj\nEMC\n(real caption)Tj\nEMC\n`);
    const content = decodePageContent(doc, 1)!;

    expect(extractMcidText(content, 11)).toBe('real caption');
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
