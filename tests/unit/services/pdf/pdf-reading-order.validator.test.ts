/**
 * Tests for PDF Reading-Order Validator (detect-only).
 *
 * Matterhorn 09-001. See pdf-reading-order.validator.ts's own header
 * comment for the real S4 Carlisle manual QC finding this investigates
 * (Karsaklian_189165_9781606497623.pdf, 16 real confirmed instances of a
 * later-tagged sidebar/figure block sitting entirely above an earlier
 * main-flow block in the same column) and for why this validator does a
 * direct pdf-lib /K walk instead of using pdfjs's own getStructTree():
 * Seam-C's own buildStructTreeFromZones (the usual fixture helper for a
 * "needs real device-space geometry" validator, see
 * pdf-heading-style-mismatch.validator.test.ts) always synthesizes a
 * geometrically-CORRECT /K order via synthesizeReadingOrder, regardless of
 * input array order -- it can never produce the deliberately-WRONG-order
 * fixture this validator's own tests need. A direct /K walk needs no
 * /ParentTree or pdfjs structTree wiring at all, so a hand-built content
 * stream (BDC/MCID-wrapped `re` rectangles, giving each zone a real,
 * controllable device-space bbox -- same technique mcid-bounding-box.
 * test.ts's own `re W n` case uses) plus a hand-built struct tree with /K
 * in whatever order the test wants is both simpler to build AND the only
 * way to actually exercise a wrong-order case.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfReadingOrderValidator } from '../../../../src/services/pdf/validators/pdf-reading-order.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

interface ZoneSpec {
  mcid: number;
  tag: string;
  /** Bottom-left-origin PDF content-stream rect. */
  rect: { x: number; y: number; w: number; h: number };
  text?: string;
}

/** A non-painted `re` per zone gives each MCID a real, controllable bbox without needing a font resource. */
function buildContentStream(zones: ZoneSpec[]): string {
  return zones
    .map((z) => {
      const textPart = z.text
        ? `BT 1 0 0 1 ${z.rect.x} ${z.rect.y + z.rect.h / 2} Tm (${z.text}) Tj ET `
        : '';
      return `<</MCID ${z.mcid}>>BDC ${z.rect.x} ${z.rect.y} ${z.rect.w} ${z.rect.h} re ${textPart}EMC`;
    })
    .join(' ');
}

/**
 * Builds a single-page, already-tagged doc whose /K order is exactly
 * `order` (indices into `zones`) -- fully independent of each zone's own
 * geometry. See this file's own header comment for why this is built by
 * hand rather than via buildStructTreeFromZones.
 */
async function buildDoc(
  zones: ZoneSpec[],
  order: number[],
  pageSize: [number, number] = [400, 900],
): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(pageSize);

  const content = buildContentStream(zones);
  const streamRef = doc.context.register(doc.context.stream(content));
  page.node.set(PDFName.of('Contents'), streamRef);

  const zoneRefs = order.map((i) => {
    const z = zones[i];
    return doc.context.register(doc.context.obj({ S: PDFName.of(z.tag), Pg: page.ref, K: z.mcid }));
  });

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: zoneRefs });
  const docRef = doc.context.register(docNode);
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return {
    pdfLibDoc: doc,
    structure: { metadata: { isTagged: true } },
  } as unknown as ParsedPDF;
}

describe('PdfReadingOrderValidator', () => {
  it(
    'flags a later-tagged /P block whose bbox sits entirely above an earlier /P block in the same column ' +
      '-- the real Karsaklian_189165 shape (a sidebar box tagged after the main flow it visually precedes)',
    async () => {
      const zones: ZoneSpec[] = [
        { mcid: 0, tag: 'H1', rect: { x: 80, y: 850, w: 200, h: 14 }, text: 'Introduction' },
        { mcid: 1, tag: 'P', rect: { x: 80, y: 100, w: 280, h: 50 }, text: 'Main body lower paragraph' },
        { mcid: 2, tag: 'P', rect: { x: 84, y: 400, w: 270, h: 50 }, text: 'Sidebar box text' },
      ];
      // Document order: heading, then the LOWER main-body paragraph, then
      // the sidebar -- even though the sidebar's own bbox (y400-450) sits
      // entirely ABOVE the main-body paragraph's bbox (y100-150).
      const parsedPdf = await buildDoc(zones, [0, 1, 2]);

      const result = await pdfReadingOrderValidator.validate(parsedPdf);

      expect(result.metadata).toEqual({ pagesAnalyzed: 1, blocksAnalyzed: 3, flagged: 1 });
      expect(result.issues).toHaveLength(1);
      const issue = result.issues[0];
      expect(issue.code).toBe('READING-ORDER-OUT-OF-SEQUENCE');
      expect(issue.matterhornCheckpoint).toBe('09-001');
      expect(issue.matterhornHow).toBe('H');
      expect(issue.category).toBe('structure');
      expect(issue.severity).toBe('moderate');
      expect(issue.pageNumber).toBe(1);
      expect(issue.wcagCriteria).toContain('1.3.2');
      expect(issue.message).toContain('Sidebar box text');
      expect(issue.message).toContain('/P');
      expect(issue.boundingBox).toMatchObject({ pageWidth: 400, pageHeight: 900 });
    },
  );

  it(
    'does not flag a genuine two-column layout -- column 2 legitimately restarts near the top of the page ' +
      'right after column 1 ends, with disjoint (non-overlapping) X ranges',
    async () => {
      const zones: ZoneSpec[] = [
        { mcid: 0, tag: 'P', rect: { x: 50, y: 100, w: 150, h: 200 }, text: 'Left column, bottom' },
        { mcid: 1, tag: 'P', rect: { x: 250, y: 700, w: 150, h: 150 }, text: 'Right column, top' },
      ];
      // Column 2 (tagged second) sits entirely ABOVE column 1 (tagged
      // first) vertically -- exactly the shape that would trip a naive
      // "later block positioned higher" check -- but the two columns' X
      // ranges (50-200 vs 250-400) don't overlap at all, so this must NOT
      // be flagged.
      const parsedPdf = await buildDoc(zones, [0, 1]);

      const result = await pdfReadingOrderValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(0);
      expect(result.metadata).toEqual({ pagesAnalyzed: 1, blocksAnalyzed: 2, flagged: 0 });
    },
  );

  it('does not flag an ordinary, correctly-ordered single-column flow (strict top-to-bottom)', async () => {
    const zones: ZoneSpec[] = [
      { mcid: 0, tag: 'P', rect: { x: 80, y: 700, w: 280, h: 50 }, text: 'First paragraph' },
      { mcid: 1, tag: 'P', rect: { x: 80, y: 500, w: 280, h: 50 }, text: 'Second paragraph' },
      { mcid: 2, tag: 'P', rect: { x: 80, y: 300, w: 280, h: 50 }, text: 'Third paragraph' },
    ];
    const parsedPdf = await buildDoc(zones, [0, 1, 2]);

    const result = await pdfReadingOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ pagesAnalyzed: 1, blocksAnalyzed: 3, flagged: 0 });
  });

  it("returns no issues for an untagged document (out of scope -- Seam-C's own from-scratch tagger always synthesizes a correct order)", async () => {
    const fakeParsedPdf = { structure: { metadata: { isTagged: false } } } as unknown as ParsedPDF;

    const result = await pdfReadingOrderValidator.validate(fakeParsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ pagesAnalyzed: 0, blocksAnalyzed: 0, flagged: 0 });
  });

  it('returns no issues for a tagged document with no /StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 900]);
    const parsedPdf = {
      pdfLibDoc: doc,
      structure: { metadata: { isTagged: true } },
    } as unknown as ParsedPDF;

    const result = await pdfReadingOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
  });
});
