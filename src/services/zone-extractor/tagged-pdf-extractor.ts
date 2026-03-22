import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'path';
import { pathToFileURL } from 'url';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../s3.service';
import type { CanonicalZoneType, BBox } from './types';
import { logger } from '../../lib/logger';
import type { Readable } from 'stream';

// Ensure pdfjs worker is configured (same pattern as pdf-parser.service.ts)
const pdfjsWorkerPath = path.join(
  process.cwd(),
  'node_modules',
  'pdfjs-dist',
  'legacy',
  'build',
  'pdf.worker.mjs',
);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfjsWorkerPath).href;

/**
 * Maps PDF structure tags to canonical zone types.
 * Matches the mapPdfxtLabel pattern from pdfxt-client.ts.
 */
const TAG_MAP: Record<string, CanonicalZoneType> = {
  'P':       'paragraph',
  'H':       'section-header',
  'H1':      'section-header',
  'H2':      'section-header',
  'H3':      'section-header',
  'H4':      'section-header',
  'H5':      'section-header',
  'H6':      'section-header',
  'Table':   'table',
  'Figure':  'figure',
  'Caption': 'caption',
  'Note':    'footnote',
  'Sect':    'paragraph',
  'Div':     'paragraph',
  'Art':     'paragraph',
  'Part':    'paragraph',
  'THead':   'header',
  'TFoot':   'footer',
  'TOC':     'paragraph',
  'TOCI':    'paragraph',
  'L':       'paragraph',
  'LI':      'paragraph',
};

export function mapStructTag(tag: string): CanonicalZoneType | null {
  return TAG_MAP[tag] ?? null;
}

export interface TaggedPdfZone {
  pageNumber: number;
  bbox: BBox;
  zoneType: CanonicalZoneType;
  confidence: number;
  label: string;
}

export interface TaggedPdfResult {
  jobId: string;
  zones: TaggedPdfZone[];
  processingTimeMs: number;
}

/**
 * Parse an s3:// URI into bucket and key.
 */
export function parseS3Path(s3Path: string): { bucket: string; key: string } {
  const stripped = s3Path.replace(/^s3:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid S3 path (no key): ${s3Path}`);
  }
  return {
    bucket: stripped.slice(0, slashIdx),
    key: stripped.slice(slashIdx + 1),
  };
}

/**
 * Collect stream chunks into a single Buffer.
 */
async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (stream instanceof Uint8Array || Buffer.isBuffer(stream)) {
    return Buffer.from(stream);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── MCID-based bbox extraction via pdfjs-dist ──────────────────────────

/**
 * Parse the integer MCID from a pdfjs-dist marked content id string.
 * pdfjs v5 returns ids like "p44R_mc0", "p44R_mc12" — the integer MCID
 * is the numeric suffix after "_mc". Falls back to direct numeric parse
 * for older pdfjs versions that return numeric strings.
 */
function parseMcid(id: string | null | undefined): number {
  if (id == null) return -1;
  // Try "_mcN" suffix pattern first (pdfjs v5)
  const match = id.match(/_mc(\d+)$/);
  if (match) return parseInt(match[1], 10);
  // Fallback: direct numeric string (older pdfjs)
  const num = Number(id);
  return isNaN(num) ? -1 : num;
}

/**
 * Per-page map of MCID → bounding box, computed from pdfjs-dist text content.
 * Key: page number (1-based), Value: Map<mcid, BBox>
 */
type McidBBoxMap = Map<number, Map<number, BBox>>;

/**
 * Build MCID → bbox mappings for all pages using pdfjs-dist.
 * pdfjs getTextContent({ includeMarkedContent: true }) returns text items
 * interspersed with beginMarkedContent / endMarkedContent markers that carry
 * the MCID. We accumulate bounding boxes for all text items under each MCID.
 */
async function buildMcidBBoxMap(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
): Promise<McidBBoxMap> {
  const pageMap: McidBBoxMap = new Map();

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    const page = await pdfjsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent({
      includeMarkedContent: true,
    });

    const mcidStack: number[] = [];
    const mcidBBoxes = new Map<number, BBox>();

    for (const item of textContent.items) {
      if ('type' in item) {
        // Marked content marker (TextMarkedContent: { type, id })
        const mc = item as unknown as { type: string; id?: string };
        if (mc.type === 'beginMarkedContent' || mc.type === 'beginMarkedContentProps') {
          // pdfjs-dist v5 returns string IDs like "p44R_mc0" where the
          // integer MCID is the suffix after "_mc". Parse it out.
          const mcid = parseMcid(mc.id);
          if (mcid >= 0) {
            mcidStack.push(mcid);
          } else {
            mcidStack.push(-1); // non-MCID marked content — push sentinel
          }
        } else if (mc.type === 'endMarkedContent') {
          mcidStack.pop();
        }
        continue;
      }

      // Regular text item with transform [scaleX, skewX, skewY, scaleY, x, y]
      const textItem = item as {
        str: string;
        transform: number[];
        width: number;
        height: number;
      };
      if (!textItem.transform || textItem.str === '') continue;

      // Find the innermost MCID from the stack
      let activeMcid = -1;
      for (let i = mcidStack.length - 1; i >= 0; i--) {
        if (mcidStack[i] >= 0) {
          activeMcid = mcidStack[i];
          break;
        }
      }
      if (activeMcid < 0) continue;

      // PDF coordinates: x,y from transform; width from item
      const x = textItem.transform[4];
      const y = textItem.transform[5];
      const fontSize = Math.abs(textItem.transform[0]);
      const w = textItem.width;
      const h = fontSize || textItem.height;

      // Convert from PDF coords (origin bottom-left) to top-left origin
      const topY = viewport.height - y - h;

      const existing = mcidBBoxes.get(activeMcid);
      if (existing) {
        const x2 = Math.max(existing.x + existing.w, x + w);
        const y2 = Math.max(existing.y + existing.h, topY + h);
        existing.x = Math.min(existing.x, x);
        existing.y = Math.min(existing.y, topY);
        existing.w = x2 - existing.x;
        existing.h = y2 - existing.y;
      } else {
        mcidBBoxes.set(activeMcid, { x, y: topY, w, h });
      }
    }

    if (mcidBBoxes.size > 0) {
      pageMap.set(pageNum, mcidBBoxes);
    }
  }

  return pageMap;
}

// ── pdf-lib struct tree walking ────────────────────────────────────────

function resolvePdfObj(obj: unknown, doc: PDFDocument): unknown {
  if (obj instanceof PDFRef) return doc.context.lookup(obj);
  return obj;
}

function getPageNumber(node: PDFDict, doc: PDFDocument): number | null {
  const pgRef = node.get(PDFName.of('Pg'));
  if (!pgRef) return null;

  const resolved = pgRef instanceof PDFRef ? pgRef : null;
  if (!resolved) return null;

  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].ref === resolved) return i + 1;
  }
  return null;
}

/**
 * Extract a BBox from explicit /BBox or /A attributes on a structure element.
 * This is the fallback path for elements that have explicit layout attributes
 * (e.g. some tagged PDFs created by certain tools).
 */
function extractExplicitBBox(
  node: PDFDict,
  doc: PDFDocument,
): BBox | null {
  const bboxArr = resolvePdfObj(node.get(PDFName.of('BBox')), doc);
  if (bboxArr instanceof PDFArray && bboxArr.size() >= 4) {
    return pdfArrayToBBox(bboxArr);
  }

  const attrRaw = node.get(PDFName.of('A'));
  if (!attrRaw) return null;

  const attr = resolvePdfObj(attrRaw, doc);
  if (attr instanceof PDFDict) {
    return extractBBoxFromAttrDict(attr);
  }
  if (attr instanceof PDFArray) {
    for (let i = 0; i < attr.size(); i++) {
      const item = resolvePdfObj(attr.get(i), doc);
      if (item instanceof PDFDict) {
        const bbox = extractBBoxFromAttrDict(item);
        if (bbox) return bbox;
      }
    }
  }
  return null;
}

function extractBBoxFromAttrDict(dict: PDFDict): BBox | null {
  const bboxKey = dict.get(PDFName.of('BBox'));
  if (bboxKey instanceof PDFArray && bboxKey.size() >= 4) {
    return pdfArrayToBBox(bboxKey);
  }
  const w = readNumber(dict, 'Width');
  const h = readNumber(dict, 'Height');
  if (w !== undefined && h !== undefined) {
    return { x: 0, y: 0, w, h };
  }
  return null;
}

function readNumber(dict: PDFDict, name: string): number | undefined {
  const val = dict.get(PDFName.of(name));
  if (val instanceof PDFNumber) return val.asNumber();
  return undefined;
}

function pdfArrayToBBox(arr: PDFArray): BBox {
  const nums = [];
  for (let i = 0; i < 4; i++) {
    const item = arr.get(i);
    nums.push(item instanceof PDFNumber ? item.asNumber() : 0);
  }
  return {
    x: Math.min(nums[0], nums[2]),
    y: Math.min(nums[1], nums[3]),
    w: Math.abs(nums[2] - nums[0]),
    h: Math.abs(nums[3] - nums[1]),
  };
}

/**
 * Collect all MCIDs from a /K entry (integer MCIDs, MCR dicts with /MCID,
 * and recursively from child arrays/refs). Does NOT recurse into child
 * structure elements (those have their own /S tag).
 */
function collectMcids(
  kEntry: unknown,
  doc: PDFDocument,
  mcids: number[],
  depth: number,
): void {
  if (depth > 50) return;

  if (kEntry instanceof PDFNumber) {
    mcids.push(kEntry.asNumber());
    return;
  }

  if (kEntry instanceof PDFRef) {
    collectMcids(doc.context.lookup(kEntry), doc, mcids, depth + 1);
    return;
  }

  if (kEntry instanceof PDFArray) {
    for (let i = 0; i < kEntry.size(); i++) {
      collectMcids(kEntry.get(i), doc, mcids, depth + 1);
    }
    return;
  }

  if (kEntry instanceof PDFDict) {
    // MCR dict: { /Type /MCR, /MCID <int>, /Pg <ref> }
    const mcidVal = kEntry.get(PDFName.of('MCID'));
    if (mcidVal instanceof PDFNumber) {
      mcids.push(mcidVal.asNumber());
      return;
    }
    // If it has /S, it's a child structure element — don't collect its MCIDs
    // (it will be processed as its own zone)
    if (kEntry.get(PDFName.of('S'))) return;
    // Otherwise recurse into /K
    const subK = kEntry.get(PDFName.of('K'));
    if (subK) collectMcids(subK, doc, mcids, depth + 1);
  }
}

/**
 * Compute the union bounding box from multiple MCIDs on a given page.
 */
function bboxFromMcids(
  mcids: number[],
  pageNum: number,
  mcidMap: McidBBoxMap,
): BBox | null {
  const pageBBoxes = mcidMap.get(pageNum);
  if (!pageBBoxes) return null;

  let result: BBox | null = null;
  for (const mcid of mcids) {
    const box = pageBBoxes.get(mcid);
    if (!box) continue;
    if (!result) {
      result = { ...box };
    } else {
      const x2 = Math.max(result.x + result.w, box.x + box.w);
      const y2 = Math.max(result.y + result.h, box.y + box.h);
      result.x = Math.min(result.x, box.x);
      result.y = Math.min(result.y, box.y);
      result.w = x2 - result.x;
      result.h = y2 - result.y;
    }
  }
  return result;
}

/**
 * Recursively walk the PDF structure tree and collect zones.
 * Uses MCID → bbox lookup from pdfjs-dist text content, with fallback
 * to explicit /BBox attributes for elements that have them.
 */
function walkStructTree(
  node: unknown,
  doc: PDFDocument,
  zones: TaggedPdfZone[],
  mcidMap: McidBBoxMap,
  currentPage: number | null,
  depth: number,
): void {
  if (depth > 100 || !node) return;

  if (node instanceof PDFRef) {
    walkStructTree(doc.context.lookup(node), doc, zones, mcidMap, currentPage, depth + 1);
    return;
  }

  if (node instanceof PDFArray) {
    for (let i = 0; i < node.size(); i++) {
      walkStructTree(node.get(i), doc, zones, mcidMap, currentPage, depth + 1);
    }
    return;
  }

  if (!(node instanceof PDFDict)) return;

  const sName = node.get(PDFName.of('S'));
  const tagName = sName instanceof PDFName ? sName.decodeText() : null;
  const pageNum = getPageNumber(node, doc) ?? currentPage;

  if (tagName) {
    const zoneType = mapStructTag(tagName);
    if (zoneType && pageNum) {
      // Try MCID-based bbox first (works for most real tagged PDFs)
      const kids = node.get(PDFName.of('K'));
      const mcids: number[] = [];
      if (kids) collectMcids(kids, doc, mcids, 0);

      let bbox = bboxFromMcids(mcids, pageNum, mcidMap);

      // Fallback: explicit /BBox or /A attributes (rare but some tools add them)
      if (!bbox) {
        bbox = extractExplicitBBox(node, doc);
      }

      if (bbox) {
        zones.push({
          pageNumber: pageNum,
          bbox,
          zoneType,
          confidence: 0.9,
          label: tagName,
        });
      }
    }
  }

  // Recurse into /K (kids) for child structure elements
  const kids = node.get(PDFName.of('K'));
  if (kids) {
    walkStructTree(kids, doc, zones, mcidMap, pageNum, depth + 1);
  }
}

/**
 * Extract zones from a pdfxt-tagged PDF stored in S3 by reading
 * its StructTreeRoot and correlating with text content positions.
 *
 * Uses pdf-lib for struct tree walking (tag names, MCIDs, page refs)
 * and pdfjs-dist for text content positions (MCID → bbox mapping).
 */
export async function extractZonesFromTaggedPdf(
  s3Path: string,
  calibrationRunId: string,
): Promise<TaggedPdfResult> {
  const startTime = Date.now();

  // 1. Download tagged PDF from S3
  const { bucket, key } = parseS3Path(s3Path);
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bytes = await streamToBuffer(response.Body);
  const uint8Array = new Uint8Array(bytes);

  // 2. Load with both pdf-lib (struct tree) and pdfjs-dist (text positions)
  const [pdfDoc, pdfjsDoc] = await Promise.all([
    PDFDocument.load(bytes, { ignoreEncryption: true }),
    pdfjsLib.getDocument({ data: uint8Array, useSystemFonts: true }).promise,
  ]);

  // 3. Check for StructTreeRoot
  const structTreeRoot = pdfDoc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structTreeRoot) {
    logger.warn(
      `[tagged-pdf-extractor] No StructTreeRoot found in ${s3Path} — ` +
      'PDF may not be tagged. Returning empty zone list.',
    );
    await pdfjsDoc.destroy();
    return { jobId: calibrationRunId, zones: [], processingTimeMs: Date.now() - startTime };
  }

  // 4. Build MCID → bbox map from pdfjs-dist text content
  const mcidMap = await buildMcidBBoxMap(pdfjsDoc);
  await pdfjsDoc.destroy();

  logger.info(
    `[tagged-pdf-extractor] Built MCID bbox map: ${[...mcidMap.entries()].reduce((sum, [, m]) => sum + m.size, 0)} MCIDs across ${mcidMap.size} pages`,
  );

  // 5. Walk struct tree and collect zones using MCID bbox lookup
  const zones: TaggedPdfZone[] = [];
  const root = resolvePdfObj(structTreeRoot, pdfDoc);
  walkStructTree(root, pdfDoc, zones, mcidMap, null, 0);

  logger.info(
    `[tagged-pdf-extractor] Extracted ${zones.length} zones from ${s3Path} ` +
    `in ${Date.now() - startTime}ms`,
  );

  return {
    jobId: calibrationRunId,
    zones,
    processingTimeMs: Date.now() - startTime,
  };
}
