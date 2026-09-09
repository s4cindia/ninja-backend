/**
 * Regression coverage for the MCID-based page-resolution fallback added to
 * resolveElementPageRef's callers (setTableSummary, findTargetTable,
 * setAltText, setActualText) in pdf-modifier.service.ts and
 * pdf-structure-writer.service.ts.
 *
 * Found via a real 805-page trial document: 14 of 189 /Table elements have
 * literally no /Pg anywhere in their entire subtree -- confirmed genuinely
 * missing tag data, not a search-depth issue (re-tested with maxDepth
 * unbounded, same result). Before this fix, resolveElementPageRef returning
 * nothing for such an element made it invisible to every *OnPage filter,
 * regardless of whether the element's own leaf MCID genuinely renders on
 * the claimed page -- content-stream evidence that exists but was never
 * consulted. The fallback added here checks that evidence directly: MCIDs
 * are page-scoped by PDF spec, so a leaf MCID this element references being
 * opened (`<< /MCID n >> BDC`) in the claimed page's own content stream is
 * real proof the element's content lives there, independent of /Pg.
 *
 * buildStructTreeFromZones's 'table' case (Table > TR > TD) does not itself
 * produce a genuine MCID binding on the TD the way its 'block' (Figure/
 * Formula) case does, so these tests borrow a REAL, content-stream-verified
 * MCID from a genuine Figure binding (produced by drawing an actual image
 * and tagging it via buildStructTreeFromZones) and reference that same
 * MCID from a hand-built Table > TR > TD with no /Pg anywhere -- exercising
 * the real regex/matching logic against genuinely BDC-marked content,
 * rather than a fabricated pattern.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString } from 'pdf-lib';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// 1×1 PNG (base64 → bytes without Buffer, which isn't in the test tsconfig scope)
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

function findFirstDict(doc: PDFDocument, tag: string): PDFDict {
  const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
  let found: PDFDict | null = null;
  const walk = (node: unknown): void => {
    if (!(node instanceof PDFDict) || found) return;
    if (node.get(PDFName.of('S'))?.toString() === `/${tag}`) {
      found = node;
      return;
    }
    const k = node.get(PDFName.of('K'));
    const kids = k instanceof PDFArray ? k.asArray() : k ? [k] : [];
    for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
  };
  walk(root);
  if (!found) throw new Error(`No /${tag} element found`);
  return found;
}

/** Appends `elem` as a new top-level child of the tree's sole /Document node. */
function appendTopLevelElement(doc: PDFDocument, elem: PDFDict): void {
  const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
  const rootK = root.get(PDFName.of('K'));
  const docRef = rootK instanceof PDFArray ? rootK.get(0) : (rootK as PDFRef);
  const docDict = doc.context.lookup(docRef) as PDFDict;
  const existing = docDict.get(PDFName.of('K'));
  const kidsArray = existing instanceof PDFArray ? existing : doc.context.obj([existing]);
  kidsArray.push(doc.context.register(elem));
  docDict.set(PDFName.of('K'), kidsArray);
}

/**
 * Builds a 1-page doc with a genuinely BDC/MCID-marked image (via a real
 * Figure zone), then adds a hand-built Table > TR > TD referencing that same
 * real MCID, with no /Pg set anywhere on the Table's own subtree.
 */
async function buildDocWithPgLessTableOnGenuineMcid(): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  const srcPage = src.addPage([400, 600]);
  const img = await src.embedPng(PNG);
  srcPage.drawImage(img, { x: 100, y: 400, width: 200, height: 100 });
  const doc = await PDFDocument.load(await src.save());

  buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 120 }, zoneType: 'figure' }]);

  const figure = findFirstDict(doc, 'Figure');
  const figureK = figure.get(PDFName.of('K'));
  const mcid = figureK instanceof PDFNumber ? figureK.asNumber() : -1;
  expect(mcid).toBeGreaterThanOrEqual(0);

  const td = doc.context.obj({ S: PDFName.of('TD'), K: PDFNumber.of(mcid) }) as PDFDict;
  const tr = doc.context.obj({ S: PDFName.of('TR'), K: [doc.context.register(td)] }) as PDFDict;
  const table = doc.context.obj({ S: PDFName.of('Table'), K: [doc.context.register(tr)] }) as PDFDict;
  appendTopLevelElement(doc, table);

  return doc;
}

describe('MCID-based page resolution fallback (no /Pg anywhere in the subtree)', () => {
  it('setTableSummary succeeds via content-stream MCID verification when the Table has no /Pg at all', async () => {
    const doc = await buildDocWithPgLessTableOnGenuineMcid();
    const table = findFirstDict(doc, 'Table');
    expect(table.get(PDFName.of('Pg'))).toBeUndefined();

    const res = await pdfModifierService.setTableSummary(doc, 'table_p1_0', 'A single-cell table');
    expect(res.success).toBe(true);

    const summary = table.get(PDFName.of('Summary'));
    expect(summary instanceof PDFString && summary.decodeText()).toBe('A single-cell table');
  });

  it('fixSimpleTableHeaders (table-header-fix) succeeds via the same fallback', async () => {
    const doc = await buildDocWithPgLessTableOnGenuineMcid();

    const issue: AuditIssue = {
      id: 'pdf-table-1',
      source: 'pdf-table',
      severity: 'serious',
      code: 'MATTERHORN-15-002',
      message: 'Data table on page 1 has no headers',
      pageNumber: 1,
      element: 'table_p1_0',
      boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
    };
    const results = pdfStructureWriterService.fixSimpleTableHeaders(doc, [issue]);
    expect(results[0].success).toBe(true);

    expect(findFirstDict(doc, 'TH')).toBeDefined(); // TD renamed to TH
  });

  it('does not falsely resolve to a page the element\'s MCID never actually appears on', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    src.addPage([400, 600]); // page 2 -- distinct, unrelated content
    const img = await src.embedPng(PNG);
    srcPage.drawImage(img, { x: 100, y: 400, width: 200, height: 100 });
    const doc = await PDFDocument.load(await src.save());

    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 120 }, zoneType: 'figure' }]);
    const figure = findFirstDict(doc, 'Figure');
    const mcid = (figure.get(PDFName.of('K')) as PDFNumber).asNumber();

    const td = doc.context.obj({ S: PDFName.of('TD'), K: PDFNumber.of(mcid) }) as PDFDict;
    const tr = doc.context.obj({ S: PDFName.of('TR'), K: [doc.context.register(td)] }) as PDFDict;
    const table = doc.context.obj({ S: PDFName.of('Table'), K: [doc.context.register(tr)] }) as PDFDict;
    appendTopLevelElement(doc, table);

    // This table's genuine MCID only appears in page 1's content -- asking
    // for page 2 must not be satisfied by a false/absent match there.
    const res = await pdfModifierService.setTableSummary(doc, 'table_p2_0', 'wrong page');
    expect(res.success).toBe(false);
    expect(table.get(PDFName.of('Summary'))).toBeUndefined();
  });
});
