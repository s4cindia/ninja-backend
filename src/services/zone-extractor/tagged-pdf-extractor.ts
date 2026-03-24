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
 * Covers standard PDF 1.7 / PDF 2.0 structure tags plus common aliases.
 */
const TAG_MAP: Record<string, CanonicalZoneType> = {
  // Block-level text
  'P':          'paragraph',
  'Span':       'paragraph',
  'BlockQuote': 'paragraph',
  'Quote':      'paragraph',
  'Code':       'paragraph',
  'Index':      'paragraph',
  'BibEntry':   'paragraph',
  'Formula':    'paragraph',
  'NonStruct':  'paragraph',
  // Headings
  'H':          'section-header',
  'H1':         'section-header',
  'H2':         'section-header',
  'H3':         'section-header',
  'H4':         'section-header',
  'H5':         'section-header',
  'H6':         'section-header',
  // Tables
  'Table':      'table',
  'TR':         'table',
  'TH':         'table',
  'TD':         'table',
  // Figures
  'Figure':     'figure',
  // Captions
  'Caption':    'caption',
  // Notes / footnotes
  'Note':       'footnote',
  'NT':         'footnote',
  'FENote':     'footnote',
  // Container / grouping (mapped to paragraph so MCIDs are not lost)
  'Sect':       'paragraph',
  'Div':        'paragraph',
  'Art':        'paragraph',
  'Part':       'paragraph',
  // Headers / footers (running)
  'THead':      'header',
  'TFoot':      'footer',
  // TOC
  'TOC':        'paragraph',
  'TOCI':       'paragraph',
  // Lists
  'L':          'paragraph',
  'LI':         'paragraph',
  'Lbl':        'paragraph',
  'LBody':      'paragraph',
  // Annotations / links
  'Annot':      'paragraph',
  'Link':       'paragraph',
  'Reference':  'paragraph',
  // Ruby / Warichu (CJK inline)
  'Ruby':       'paragraph',
  'Warichu':    'paragraph',
};

/**
 * Resolve a tag name through a RoleMap, then look up in TAG_MAP.
 * RoleMap maps custom tag names to standard tags (e.g. Title → H1).
 */
export function mapStructTag(
  tag: string,
  roleMap?: Map<string, string>,
): CanonicalZoneType | null {
  const resolvedTag = roleMap?.get(tag) ?? tag;
  return TAG_MAP[resolvedTag] ?? null;
}

/**
 * Build a RoleMap from the StructTreeRoot's /RoleMap dictionary.
 * Returns Map<customTagName, standardTagName>.
 */
function buildRoleMap(
  structTreeRoot: PDFDict,
  doc: PDFDocument,
): Map<string, string> {
  const roleMap = new Map<string, string>();
  const rmRaw = structTreeRoot.get(PDFName.of('RoleMap'));
  const rm = resolvePdfObj(rmRaw, doc);
  if (!(rm instanceof PDFDict)) return roleMap;

  const entries = rm.entries();
  for (const [key, value] of entries) {
    const customTag = key instanceof PDFName ? key.decodeText() : String(key);
    const stdTag = value instanceof PDFName ? value.decodeText() : null;
    if (stdTag) {
      roleMap.set(customTag, stdTag);
    }
  }

  if (roleMap.size > 0) {
    logger.debug(
      `[tagged-pdf-extractor] RoleMap: ${roleMap.size} entries — ${[...roleMap.entries()].slice(0, 10).map(([k, v]) => `${k}→${v}`).join(', ')}`,
    );
  }
  return roleMap;
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

interface McidRef {
  mcid: number;
  pageNum: number | null; // page override from MCR /Pg, or null to use parent's page
}

/**
 * Collect all MCIDs from a /K entry (integer MCIDs, MCR dicts with /MCID,
 * and recursively from child arrays/refs). Does NOT recurse into child
 * structure elements (those have their own /S tag).
 *
 * MCR dicts may carry their own /Pg reference that overrides the parent
 * structure element's page — we preserve this so MCIDs are looked up in
 * the correct page's bbox map.
 */
function collectMcids(
  kEntry: unknown,
  doc: PDFDocument,
  mcidRefs: McidRef[],
  depth: number,
): void {
  if (depth > 50) return;

  if (kEntry instanceof PDFNumber) {
    mcidRefs.push({ mcid: kEntry.asNumber(), pageNum: null });
    return;
  }

  if (kEntry instanceof PDFRef) {
    collectMcids(doc.context.lookup(kEntry), doc, mcidRefs, depth + 1);
    return;
  }

  if (kEntry instanceof PDFArray) {
    for (let i = 0; i < kEntry.size(); i++) {
      collectMcids(kEntry.get(i), doc, mcidRefs, depth + 1);
    }
    return;
  }

  if (kEntry instanceof PDFDict) {
    // MCR dict: { /Type /MCR, /MCID <int>, /Pg <ref> }
    const mcidVal = kEntry.get(PDFName.of('MCID'));
    if (mcidVal instanceof PDFNumber) {
      // Check if MCR has its own /Pg reference (page override)
      const mcrPageRef = kEntry.get(PDFName.of('Pg'));
      let mcrPageNum: number | null = null;
      if (mcrPageRef instanceof PDFRef) {
        const pages = doc.getPages();
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].ref === mcrPageRef) {
            mcrPageNum = i + 1;
            break;
          }
        }
      }
      mcidRefs.push({ mcid: mcidVal.asNumber(), pageNum: mcrPageNum });
      return;
    }
    // OBJR dict: { /Type /OBJR, /Obj <ref>, /Pg <ref> } — object reference
    // (annotations, XObjects). Skip for now — P1 will handle these.
    const typeVal = kEntry.get(PDFName.of('Type'));
    if (typeVal instanceof PDFName && typeVal.decodeText() === 'OBJR') return;
    // If it has /S, it's a child structure element — don't collect its MCIDs
    if (kEntry.get(PDFName.of('S'))) return;
    // Otherwise recurse into /K
    const subK = kEntry.get(PDFName.of('K'));
    if (subK) collectMcids(subK, doc, mcidRefs, depth + 1);
  }
}

/**
 * Compute the union bounding box from McidRefs.
 * Each McidRef may override the page number (from MCR /Pg); if null,
 * falls back to the parent structure element's page.
 */
function bboxFromMcidRefs(
  mcidRefs: McidRef[],
  parentPageNum: number,
  mcidMap: McidBBoxMap,
): BBox | null {
  let result: BBox | null = null;
  for (const ref of mcidRefs) {
    const effectivePage = ref.pageNum ?? parentPageNum;
    const pageBBoxes = mcidMap.get(effectivePage);
    if (!pageBBoxes) continue;
    const box = pageBBoxes.get(ref.mcid);
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

/** Extraction diagnostic counters — reset per extraction run. */
interface ExtractionStats {
  structElements: number;
  unmappedTags: Map<string, number>;
  noPageNum: number;
  mcidsFound: number;
  mcidsWithBbox: number;
  bboxFromExplicit: number;
  droppedNoBbox: number;
}

function newExtractionStats(): ExtractionStats {
  return {
    structElements: 0,
    unmappedTags: new Map(),
    noPageNum: 0,
    mcidsFound: 0,
    mcidsWithBbox: 0,
    bboxFromExplicit: 0,
    droppedNoBbox: 0,
  };
}

/**
 * Recursively walk the PDF structure tree and collect zones.
 * Uses MCID → bbox lookup from pdfjs-dist text content, with fallback
 * to explicit /BBox attributes for elements that have them.
 * Resolves custom tags through the RoleMap before TAG_MAP lookup.
 */
function walkStructTree(
  node: unknown,
  doc: PDFDocument,
  zones: TaggedPdfZone[],
  mcidMap: McidBBoxMap,
  roleMap: Map<string, string>,
  stats: ExtractionStats,
  currentPage: number | null,
  depth: number,
): void {
  if (depth > 100 || !node) return;

  if (node instanceof PDFRef) {
    walkStructTree(doc.context.lookup(node), doc, zones, mcidMap, roleMap, stats, currentPage, depth + 1);
    return;
  }

  if (node instanceof PDFArray) {
    for (let i = 0; i < node.size(); i++) {
      walkStructTree(node.get(i), doc, zones, mcidMap, roleMap, stats, currentPage, depth + 1);
    }
    return;
  }

  if (!(node instanceof PDFDict)) return;

  const sName = node.get(PDFName.of('S'));
  const rawTag = sName instanceof PDFName ? sName.decodeText() : null;
  const pageNum = getPageNumber(node, doc) ?? currentPage;

  if (rawTag) {
    stats.structElements++;
    const zoneType = mapStructTag(rawTag, roleMap);
    const resolvedTag = roleMap.get(rawTag) ?? rawTag;

    if (!zoneType) {
      const count = stats.unmappedTags.get(rawTag) ?? 0;
      stats.unmappedTags.set(rawTag, count + 1);
    } else if (!pageNum) {
      stats.noPageNum++;
    } else {
      // Collect MCIDs with page overrides from MCR /Pg refs
      const kids = node.get(PDFName.of('K'));
      const mcidRefs: McidRef[] = [];
      if (kids) collectMcids(kids, doc, mcidRefs, 0);
      stats.mcidsFound += mcidRefs.length;

      let bbox = bboxFromMcidRefs(mcidRefs, pageNum, mcidMap);
      if (bbox) {
        stats.mcidsWithBbox += mcidRefs.length;
      }

      // Fallback: explicit /BBox or /A attributes
      if (!bbox) {
        bbox = extractExplicitBBox(node, doc);
        if (bbox) stats.bboxFromExplicit++;
      }

      if (bbox) {
        zones.push({
          pageNumber: pageNum,
          bbox,
          zoneType,
          confidence: 0.9,
          label: resolvedTag,
        });
      } else {
        stats.droppedNoBbox++;
      }
    }
  }

  // Recurse into /K (kids) for child structure elements
  const kids = node.get(PDFName.of('K'));
  if (kids) {
    walkStructTree(kids, doc, zones, mcidMap, roleMap, stats, pageNum, depth + 1);
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

  // 5. Build RoleMap for custom tag resolution
  const root = resolvePdfObj(structTreeRoot, pdfDoc);
  const roleMap = root instanceof PDFDict ? buildRoleMap(root, pdfDoc) : new Map<string, string>();

  // 6. Walk struct tree and collect zones using MCID bbox lookup
  const zones: TaggedPdfZone[] = [];
  const stats = newExtractionStats();
  walkStructTree(root, pdfDoc, zones, mcidMap, roleMap, stats, null, 0);

  // 7. Log extraction diagnostics
  const perPage = new Map<number, number>();
  for (const z of zones) {
    perPage.set(z.pageNumber, (perPage.get(z.pageNumber) ?? 0) + 1);
  }

  logger.info(
    `[tagged-pdf-extractor] Extracted ${zones.length} zones from ${s3Path} in ${Date.now() - startTime}ms | ` +
    `struct_elements=${stats.structElements} mcids_found=${stats.mcidsFound} mcids_with_bbox=${stats.mcidsWithBbox} ` +
    `bbox_from_explicit=${stats.bboxFromExplicit} dropped_no_bbox=${stats.droppedNoBbox} no_page=${stats.noPageNum}`,
  );

  if (stats.unmappedTags.size > 0) {
    logger.warn(
      `[tagged-pdf-extractor] Unmapped tags: ${[...stats.unmappedTags.entries()].map(([t, c]) => `${t}(${c})`).join(', ')}`,
    );
  }

  if (stats.droppedNoBbox > 0) {
    logger.warn(
      `[tagged-pdf-extractor] ${stats.droppedNoBbox} structure elements dropped (no bbox from MCIDs or explicit attributes)`,
    );
  }

  // Log pages with 0 zones as potential extraction gaps
  const totalPages = pdfDoc.getPageCount();
  const emptyPages: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!perPage.has(p)) emptyPages.push(p);
  }
  if (emptyPages.length > 0 && emptyPages.length < totalPages) {
    logger.warn(
      `[tagged-pdf-extractor] Pages with 0 pdfxt zones: ${emptyPages.join(', ')} (${emptyPages.length}/${totalPages})`,
    );
  }

  return {
    jobId: calibrationRunId,
    zones,
    processingTimeMs: Date.now() - startTime,
  };
}
