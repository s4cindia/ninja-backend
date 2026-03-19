import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../s3.service';
import type { CanonicalZoneType, BBox } from './types';
import { logger } from '../../lib/logger';
import type { Readable } from 'stream';

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

/**
 * Read a numeric value from a PDFDict entry.
 */
function readNumber(dict: PDFDict, name: string): number | undefined {
  const val = dict.get(PDFName.of(name));
  if (val instanceof PDFNumber) return val.asNumber();
  return undefined;
}

/**
 * Extract a BBox from a structure element's /A (attributes) dict.
 * PDF structure elements store layout info in attribute objects,
 * typically under /BBox as [x, y, width, height].
 */
function extractBBox(
  node: PDFDict,
  doc: PDFDocument,
): BBox | null {
  // Try /BBox directly on the node (some tagged PDFs)
  const bboxArr = resolvePdfObj(node.get(PDFName.of('BBox')), doc);
  if (bboxArr instanceof PDFArray && bboxArr.size() >= 4) {
    return pdfArrayToBBox(bboxArr);
  }

  // Try /A (attribute dict or array of attribute dicts)
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

  // Fallback: Width/Height attributes (less common)
  const w = readNumber(dict, 'Width');
  const h = readNumber(dict, 'Height');
  if (w !== undefined && h !== undefined) {
    return { x: 0, y: 0, w, h };
  }

  return null;
}

function pdfArrayToBBox(arr: PDFArray): BBox {
  const nums = [];
  for (let i = 0; i < 4; i++) {
    const item = arr.get(i);
    nums.push(item instanceof PDFNumber ? item.asNumber() : 0);
  }
  // PDF /BBox is [x1, y1, x2, y2] (lower-left to upper-right)
  // Convert to { x, y, w, h } format used by zone matcher
  return {
    x: Math.min(nums[0], nums[2]),
    y: Math.min(nums[1], nums[3]),
    w: Math.abs(nums[2] - nums[0]),
    h: Math.abs(nums[3] - nums[1]),
  };
}

/**
 * Resolve PDFRef to the underlying object.
 */
function resolvePdfObj(obj: unknown, doc: PDFDocument): unknown {
  if (obj instanceof PDFRef) return doc.context.lookup(obj);
  return obj;
}

/**
 * Get the page number (1-based) for a structure element by resolving its /Pg reference.
 */
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
 * Recursively walk the PDF structure tree and collect zones.
 * Follows the same pattern as accessibility.processor.ts collectLangAttributes().
 */
function walkStructTree(
  node: unknown,
  doc: PDFDocument,
  zones: TaggedPdfZone[],
  currentPage: number | null,
  depth: number,
): void {
  if (depth > 100 || !node) return;

  if (node instanceof PDFRef) {
    walkStructTree(doc.context.lookup(node), doc, zones, currentPage, depth + 1);
    return;
  }

  if (node instanceof PDFArray) {
    for (let i = 0; i < node.size(); i++) {
      walkStructTree(node.get(i), doc, zones, currentPage, depth + 1);
    }
    return;
  }

  if (!(node instanceof PDFDict)) return;

  // Read tag name from /S
  const sName = node.get(PDFName.of('S'));
  const tagName = sName instanceof PDFName ? sName.decodeText() : null;

  // Resolve page number from /Pg (inherit from parent if not present)
  const pageNum = getPageNumber(node, doc) ?? currentPage;

  // If this is a known leaf-level tag, try to extract bbox
  if (tagName) {
    const zoneType = mapStructTag(tagName);
    if (zoneType && pageNum) {
      const bbox = extractBBox(node, doc);
      if (bbox) {
        zones.push({
          pageNumber: pageNum,
          bbox,
          zoneType,
          confidence: 0.9,
          label: tagName,
        });
      }
      // Even without bbox, still recurse into children
    }
  }

  // Recurse into /K (kids)
  const kids = node.get(PDFName.of('K'));
  if (kids) {
    walkStructTree(kids, doc, zones, pageNum, depth + 1);
  }
}

/**
 * Extract zones from a pdfxt-tagged PDF stored in S3 by reading
 * its StructTreeRoot. This replaces the pdfxt HTTP API call.
 *
 * Uses the same pdf-lib struct tree walking pattern as
 * accessibility.processor.ts (catalog.get(PDFName.of('StructTreeRoot'))).
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
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

  // 2. Get StructTreeRoot — same pattern as accessibility.processor.ts line 49
  const structTreeRoot = pdfDoc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structTreeRoot) {
    logger.warn(
      `[tagged-pdf-extractor] No StructTreeRoot found in ${s3Path} — ` +
      'PDF may not be tagged. Returning empty zone list.',
    );
    return { jobId: calibrationRunId, zones: [], processingTimeMs: Date.now() - startTime };
  }

  // 3. Walk struct tree recursively
  const zones: TaggedPdfZone[] = [];
  const root = resolvePdfObj(structTreeRoot, pdfDoc);
  walkStructTree(root, pdfDoc, zones, null, 0);

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
