/**
 * Tests for PDF Reading-Order Validator (detect-only).
 *
 * Matterhorn 09-001. See pdf-reading-order.validator.ts's own header
 * comment for the real S4 Carlisle manual QC finding this investigates
 * (Karsaklian_189165_9781606497623.pdf, 16 real confirmed instances of a
 * later-tagged sidebar/figure block sitting entirely above an earlier
 * main-flow block in the same column) AND for the real post-ship bug this
 * file's own fixtures were rewritten to catch: the FIRST shipped version
 * (a direct pdf-lib /K walk comparing only GLOBALLY-adjacent flattened
 * blocks) returned zero issues against the real file, because the real
 * document's own two same-page blocks are hundreds of struct elements
 * apart in the document's global /K order (InDesign exports each threaded
 * STORY as its own contiguous run, not interleaved per page). This file's
 * "far apart in the global /K order" test below reproduces that exact
 * bug class synthetically, so a future regression of the same kind fails
 * a unit test instead of only showing up on the real file.
 *
 * Fixture strategy: pdfjs's own page.getStructTree() -- which this
 * validator now uses (see the architecture note in the validator's own
 * header comment) -- reconstructs each page's structure BOTTOM-UP from
 * its own /ParentTree + each StructElem's own /P parent link (confirmed by
 * reading pdfjs-dist's own StructTreePage source), not by a top-down /K
 * walk alone. Seam-C's own buildStructTreeFromZones (the usual fixture
 * helper for a "needs real device-space geometry" validator, see
 * pdf-heading-style-mismatch.validator.test.ts) can't be used here either:
 * it always synthesizes a geometrically-CORRECT /K order via
 * synthesizeReadingOrder, regardless of input order, so it can never
 * produce the deliberately-WRONG-order fixtures these tests need. Instead,
 * buildTaggedDoc below uses pdf-lib's own real page.drawText() (real font
 * metrics, so buildContentIdBBoxMap gets a REAL glyph-width bbox, not just
 * an anchor point) for each zone, then wraps each drawn text run's own
 * `q BT ... ET Q` block in `/P <</MCID n>> BDC ... EMC` (one MCID per zone,
 * per page), and hand-builds a full StructTreeRoot + /ParentTree + /P
 * parent links + /MarkInfo so pdfjs's own getStructTree() resolves it
 * correctly -- confirmed empirically (a bare StructTreeRoot /K walk with
 * no /ParentTree/　/P wiring returns an EMPTY tree from pdfjs, even though
 * it's exactly what a raw pdf-lib /K walk would still see).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFRef, StandardFonts } from 'pdf-lib';
import { pdfReadingOrderValidator } from '../../../../src/services/pdf/validators/pdf-reading-order.validator';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

interface ZoneSpec {
  tag: string;
  text: string;
  x: number;
  y: number;
  size?: number;
}

interface PageSpec {
  size: [number, number];
  /** Drawn (and therefore content-stream/MCID-ordered) in array order -- independent of the struct tree's own /K order, which `globalOrder` controls separately. */
  zones: ZoneSpec[];
}

/**
 * Builds a multi-page, already-tagged document whose struct tree's /K
 * order is exactly `globalOrder` (a flat, document-wide sequence of
 * {page, zone} indices) -- fully independent of each zone's own page,
 * geometry, or content-stream position. See this file's own header
 * comment for why this is hand-built rather than via
 * buildStructTreeFromZones.
 */
async function buildTaggedDoc(
  pages: PageSpec[],
  globalOrder: Array<{ page: number; zone: number }>,
): Promise<ParsedPDF> {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pdfPages = pages.map((p) => src.addPage(p.size));
  for (let pi = 0; pi < pages.length; pi++) {
    for (const z of pages[pi].zones) {
      pdfPages[pi].drawText(z.text, { x: z.x, y: z.y, size: z.size ?? 12, font });
    }
  }
  const doc = await PDFDocument.load(await src.save());

  // Per page: split its own content into per-zone `q\nBT\n...\nQ\n` blocks
  // (drawText call order == zones[] array order -- verified empirically:
  // each drawText call emits its own self-contained q/BT/.../ET/Q run),
  // wrap each with its own MCID (its own index within THAT page), rewrite
  // /Contents with the wrapped version.
  const zoneRefsByPage: PDFRef[][] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const pageNum = pi + 1;
    const raw = decodePageContent(doc, pageNum)!;
    const blocks = raw.split(/(?=q\nBT\n)/).filter((b) => b.trim().length > 0);
    const wrapped = blocks.map((b, i) => `/P <</MCID ${i}>> BDC\n${b}EMC\n`).join('');
    writePageContent(doc, pageNum, wrapped);

    const page = doc.getPages()[pi];
    page.node.set(PDFName.of('StructParents'), doc.context.obj(pi));

    const refs = pages[pi].zones.map((z, i) =>
      doc.context.register(doc.context.obj({ S: PDFName.of(z.tag), Pg: page.ref, K: i })),
    );
    zoneRefsByPage.push(refs);
  }

  const orderedRefs = globalOrder.map(({ page, zone }) => zoneRefsByPage[page][zone]);
  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: orderedRefs });
  const docRef = doc.context.register(docNode);
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
  for (const refs of zoneRefsByPage) {
    for (const ref of refs) doc.context.lookup(ref, PDFDict).set(PDFName.of('P'), docRef);
  }
  doc.context.lookup(docRef, PDFDict).set(PDFName.of('P'), structTreeRootRef);

  // /ParentTree: one Nums entry per page, keyed by that page's own
  // /StructParents number, value = that page's own zone refs (indexed by
  // MCID, i.e. by position within that page's own zones[] array).
  const numsEntries: unknown[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    numsEntries.push(pi, doc.context.obj(zoneRefsByPage[pi]));
  }
  const parentTree = doc.context.obj({ Nums: numsEntries });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  const markInfoRef = doc.context.register(doc.context.obj({ Marked: true }));
  doc.catalog.set(PDFName.of('MarkInfo'), markInfoRef);

  const buffer = Buffer.from(await doc.save());
  return pdfParserService.parseBuffer(buffer, 'reading-order-fixture.pdf');
}

describe('PdfReadingOrderValidator', () => {
  it(
    'flags a later-tagged /P block whose bbox sits entirely above an earlier /P block in the same column ' +
      '-- the real Karsaklian_189165 shape (a sidebar box tagged after the main flow it visually precedes)',
    async () => {
      const pages: PageSpec[] = [
        {
          size: [400, 900],
          zones: [
            { tag: 'H1', text: 'Introduction', x: 80, y: 850 },
            { tag: 'P', text: 'Main body paragraph positioned lower on the page', x: 80, y: 100 },
            { tag: 'P', text: 'Sidebar box text positioned higher on the page', x: 84, y: 400 },
          ],
        },
      ];
      // Document order: heading, then the LOWER main-body paragraph, then
      // the sidebar -- even though the sidebar's own bbox (around y=400)
      // sits entirely ABOVE the main-body paragraph's bbox (around y=100).
      const parsedPdf = await buildTaggedDoc(pages, [{ page: 0, zone: 0 }, { page: 0, zone: 1 }, { page: 0, zone: 2 }]);

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
    "reproduces the real post-ship bug class: a page's own two blocks are hundreds of struct elements apart " +
      'in the GLOBAL /K order (another page\'s whole content sits between them, mirroring how InDesign exports ' +
      'each threaded story as its own contiguous run) -- still flagged, because this validator works ' +
      'page-by-page via pdfjs\'s own getStructTree() rather than scanning a flattened global array',
    async () => {
      const pages: PageSpec[] = [
        {
          size: [400, 900],
          zones: [
            { tag: 'P', text: 'Page one main body paragraph, positioned lower on the page', x: 80, y: 100 },
            { tag: 'P', text: 'Page one sidebar text, positioned higher on the same page', x: 84, y: 600 },
          ],
        },
        {
          size: [400, 900],
          zones: [{ tag: 'P', text: 'An entirely unrelated paragraph on a completely different page', x: 80, y: 400 }],
        },
      ];
      // Global /K order: page 1's FIRST block, then ALL of page 2's
      // content, then page 1's SECOND block dead last -- the exact shape
      // that broke the first shipped version's "compare globally-adjacent
      // entries" loop.
      const parsedPdf = await buildTaggedDoc(pages, [
        { page: 0, zone: 0 },
        { page: 1, zone: 0 },
        { page: 0, zone: 1 },
      ]);

      const result = await pdfReadingOrderValidator.validate(parsedPdf);

      expect(result.metadata).toEqual({ pagesAnalyzed: 2, blocksAnalyzed: 3, flagged: 1 });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].pageNumber).toBe(1);
      expect(result.issues[0].message).toContain('Page one sidebar text');
    },
  );

  it(
    'does not flag a genuine two-column layout -- column 2 legitimately restarts near the top of the page ' +
      'right after column 1 ends, with disjoint (non-overlapping) X ranges',
    async () => {
      const pages: PageSpec[] = [
        {
          size: [400, 900],
          zones: [
            { tag: 'P', text: 'Left column text', x: 50, y: 100 },
            { tag: 'P', text: 'Right col', x: 280, y: 700 },
          ],
        },
      ];
      // Column 2 (tagged second) sits entirely ABOVE column 1 (tagged
      // first) vertically -- exactly the shape that would trip a naive
      // "later block positioned higher" check -- but the two columns' X
      // ranges don't overlap at all, so this must NOT be flagged.
      const parsedPdf = await buildTaggedDoc(pages, [{ page: 0, zone: 0 }, { page: 0, zone: 1 }]);

      const result = await pdfReadingOrderValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(0);
      expect(result.metadata).toEqual({ pagesAnalyzed: 1, blocksAnalyzed: 2, flagged: 0 });
    },
  );

  it('does not flag an ordinary, correctly-ordered single-column flow (strict top-to-bottom)', async () => {
    const pages: PageSpec[] = [
      {
        size: [400, 900],
        zones: [
          { tag: 'P', text: 'First paragraph text here', x: 80, y: 700 },
          { tag: 'P', text: 'Second paragraph text here', x: 80, y: 500 },
          { tag: 'P', text: 'Third paragraph text here', x: 80, y: 300 },
        ],
      },
    ];
    const parsedPdf = await buildTaggedDoc(pages, [{ page: 0, zone: 0 }, { page: 0, zone: 1 }, { page: 0, zone: 2 }]);

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

  it('returns no issues for a real document with no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 900]);
    const buffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(buffer, 'no-struct-tree.pdf');
    // Force the isTagged gate open so this test exercises the "pdfjs has no
    // real struct tree to return" path specifically, not just the isTagged
    // early return.
    parsedPdf.structure.metadata.isTagged = true;

    const result = await pdfReadingOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
  });
});
