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
  bbox: BBox | null;
  zoneType: CanonicalZoneType;
  confidence: number;
  label: string;
  isGhost?: boolean;   // true when struct element found but no bbox computable
  ghostTag?: string;   // original raw tag name for ghost zones
}

export interface PageClassificationInfo {
  pageNumber: number;
  pageType: string;
  zoneCount: number;
  confidence: number;
}

export interface TaggedPdfExtractionStats {
  structElements: number;
  zonesExtracted: number;
  ghostZones: number;
  textMcids: number;
  imageMcids: number;
  opListTextMcids: number;
  opListPathMcids: number;
  droppedNoBbox: number;
  unmappedTags: Record<string, number>;
  pagesWithZeroZones: number[];
  pageClassifications: PageClassificationInfo[];
}

export interface TaggedPdfResult {
  jobId: string;
  zones: TaggedPdfZone[];
  processingTimeMs: number;
  extractionStats?: TaggedPdfExtractionStats;
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
      if (!textItem.transform) continue;
      // Note: we do NOT skip empty-string items (textItem.str === '')
      // because some MCIDs (e.g., Figure placeholders) only have empty
      // text items. Skipping them would orphan those MCIDs.
      // Items with no width/height will contribute zero bbox anyway.

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

// ── Operator-list MCID extraction (text, images, paths) ─────────────

/**
 * Multiply two 6-element PDF transform matrices [a,b,c,d,e,f].
 */
function multiplyTransforms(t1: number[], t2: number[]): number[] {
  return [
    t1[0] * t2[0] + t1[2] * t2[1],
    t1[1] * t2[0] + t1[3] * t2[1],
    t1[0] * t2[2] + t1[2] * t2[3],
    t1[1] * t2[2] + t1[3] * t2[3],
    t1[0] * t2[4] + t1[2] * t2[5] + t1[4],
    t1[1] * t2[4] + t1[3] * t2[5] + t1[5],
  ];
}

interface OperatorListStats {
  imagesMapped: number;
  textMapped: number;
  pathMapped: number;
}

/**
 * Augment the MCID bbox map using getOperatorList() to capture ALL content
 * types within marked content sections: text draws, images, and paths.
 *
 * getTextContent() misses ~31% of MCIDs because it doesn't surface marked
 * content wrappers for certain elements (empty text, paths, vector graphics,
 * nested structures). This function directly parses the content stream
 * operators to capture those missing MCIDs.
 *
 * Only fills MCIDs that are NOT already in the text-based mcidMap
 * (text content layer takes priority since it has more precise positioning).
 */
async function augmentMcidMapFromOperatorList(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
  mcidMap: McidBBoxMap,
): Promise<OperatorListStats> {
  const OPS = pdfjsLib.OPS;
  let imagesMapped = 0;
  let textMapped = 0;
  let pathMapped = 0;

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    const page = await pdfjsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const opList = await page.getOperatorList();

    const fnArray = opList.fnArray as number[];
    const argsArray = opList.argsArray as unknown[][];

    // Graphics state
    const mcidStack: number[] = [];
    const transformStack: number[][] = [];
    let currentTransform = [1, 0, 0, 1, 0, 0];

    // Text state
    let textMatrix = [1, 0, 0, 1, 0, 0];
    let textLineMatrix = [1, 0, 0, 1, 0, 0];
    let fontSize = 12;
    let leading = 0;

    // Snapshot of text-based map for this page (skip MCIDs already mapped)
    const existingPageMap = mcidMap.get(pageNum);

    /** Find the innermost MCID not already in the text-based map. */
    function getNewActiveMcid(): number {
      for (let j = mcidStack.length - 1; j >= 0; j--) {
        if (mcidStack[j] >= 0) {
          const mcid = mcidStack[j];
          if (existingPageMap?.has(mcid)) return -1;
          return mcid;
        }
      }
      return -1;
    }

    /** Merge a bbox into the mcidMap for this page. Returns true if MCID is new. */
    function mergeBBox(mcid: number, bbox: BBox): boolean {
      if (!mcidMap.has(pageNum)) mcidMap.set(pageNum, new Map());
      const pm = mcidMap.get(pageNum)!;
      const existing = pm.get(mcid);
      if (existing) {
        const x2 = Math.max(existing.x + existing.w, bbox.x + bbox.w);
        const y2 = Math.max(existing.y + existing.h, bbox.y + bbox.h);
        existing.x = Math.min(existing.x, bbox.x);
        existing.y = Math.min(existing.y, bbox.y);
        existing.w = x2 - existing.x;
        existing.h = y2 - existing.y;
        return false;
      }
      pm.set(mcid, { ...bbox });
      return true;
    }

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];

      // ── Graphics state ──
      if (fn === OPS.save) {
        transformStack.push([...currentTransform]);
      } else if (fn === OPS.restore) {
        if (transformStack.length > 0) currentTransform = transformStack.pop()!;
      } else if (fn === OPS.transform) {
        currentTransform = multiplyTransforms(currentTransform, args as number[]);
      }
      // ── Marked content ──
      else if (fn === OPS.beginMarkedContent) {
        mcidStack.push(-1);
      } else if (fn === OPS.beginMarkedContentProps) {
        const props = args[1] as Record<string, unknown> | undefined;
        const mcid = typeof props?.mcid === 'number' ? props.mcid : -1;
        mcidStack.push(mcid);
      } else if (fn === OPS.endMarkedContent) {
        mcidStack.pop();
      }
      // ── Text state ──
      else if (fn === OPS.beginText) {
        textMatrix = [1, 0, 0, 1, 0, 0];
        textLineMatrix = [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.setFont) {
        fontSize = (args as [unknown, number])[1] || 12;
      } else if (fn === OPS.setTextMatrix) {
        const tm = args as number[];
        textMatrix = [...tm];
        textLineMatrix = [...tm];
      } else if (fn === OPS.moveText) {
        // Td operator: translate text line matrix
        const [tx, ty] = args as number[];
        textLineMatrix = [
          textLineMatrix[0], textLineMatrix[1],
          textLineMatrix[2], textLineMatrix[3],
          textLineMatrix[0] * tx + textLineMatrix[2] * ty + textLineMatrix[4],
          textLineMatrix[1] * tx + textLineMatrix[3] * ty + textLineMatrix[5],
        ];
        textMatrix = [...textLineMatrix];
      } else if (fn === OPS.setLeading) {
        leading = (args as number[])[0];
      } else if (fn === OPS.nextLine) {
        // T* = 0 -TL Td
        textLineMatrix = [
          textLineMatrix[0], textLineMatrix[1],
          textLineMatrix[2], textLineMatrix[3],
          textLineMatrix[2] * (-leading) + textLineMatrix[4],
          textLineMatrix[3] * (-leading) + textLineMatrix[5],
        ];
        textMatrix = [...textLineMatrix];
      }
      // ── Text drawing (Tj, TJ, ', ") ──
      else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        const activeMcid = getNewActiveMcid();
        if (activeMcid >= 0) {
          // Compute text position in user space: CTM × textMatrix
          const tm = multiplyTransforms(currentTransform, textMatrix);
          const x = tm[4];
          const y = tm[5];
          const scaledFontSize = Math.abs(tm[3]) || Math.abs(fontSize * Math.abs(currentTransform[3])) || fontSize;

          // Estimate text width from glyph data in operator args
          let estWidth = 0;
          const glyphs = args[0];
          if (Array.isArray(glyphs)) {
            for (const g of glyphs) {
              if (typeof g === 'object' && g !== null && 'width' in g) {
                estWidth += ((g as { width: number }).width * fontSize) / 1000;
              } else if (typeof g === 'number') {
                // TJ spacing adjustment (thousandths of text unit, negative = advance)
                estWidth -= (g * fontSize) / 1000;
              }
            }
          }
          if (estWidth <= 0) estWidth = scaledFontSize * 3; // rough fallback

          const h = scaledFontSize;
          const topY = viewport.height - y - h;

          if (mergeBBox(activeMcid, { x, y: topY, w: Math.abs(estWidth), h })) {
            textMapped++;
          }
        }

        // Advance text matrix by drawn width (approximate — move past drawn glyphs)
        // This ensures subsequent Tj calls on same line don't overlap
        let advance = 0;
        const glyphs = args[0];
        if (Array.isArray(glyphs)) {
          for (const g of glyphs) {
            if (typeof g === 'object' && g !== null && 'width' in g) {
              advance += ((g as { width: number }).width * fontSize) / 1000;
            } else if (typeof g === 'number') {
              advance -= (g * fontSize) / 1000;
            }
          }
        }
        if (advance > 0) {
          textMatrix = [
            textMatrix[0], textMatrix[1],
            textMatrix[2], textMatrix[3],
            textMatrix[0] * advance + textMatrix[4],
            textMatrix[1] * advance + textMatrix[5],
          ];
        }
      } else if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
        // Move to next line, then show text
        textLineMatrix = [
          textLineMatrix[0], textLineMatrix[1],
          textLineMatrix[2], textLineMatrix[3],
          textLineMatrix[2] * (-leading) + textLineMatrix[4],
          textLineMatrix[3] * (-leading) + textLineMatrix[5],
        ];
        textMatrix = [...textLineMatrix];

        const activeMcid = getNewActiveMcid();
        if (activeMcid >= 0) {
          const tm = multiplyTransforms(currentTransform, textMatrix);
          const x = tm[4];
          const y = tm[5];
          const scaledFontSize = Math.abs(tm[3]) || fontSize;
          const h = scaledFontSize;
          const topY = viewport.height - y - h;
          const estWidth = scaledFontSize * 5; // rough estimate

          if (mergeBBox(activeMcid, { x, y: topY, w: estWidth, h })) {
            textMapped++;
          }
        }
      }
      // ── Images ──
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const activeMcid = getNewActiveMcid();
        if (activeMcid >= 0) {
          const [a, b, c, d, e, f] = currentTransform;
          const width = Math.sqrt(a * a + b * b);
          const height = Math.sqrt(c * c + d * d);
          const x = e;
          const y = viewport.height - f - height;

          if (mergeBBox(activeMcid, { x, y, w: width, h: height })) {
            imagesMapped++;
          }
        }
      }
      // ── Paths (constructPath carries minMax bbox) ──
      else if (fn === OPS.constructPath) {
        const activeMcid = getNewActiveMcid();
        if (activeMcid >= 0) {
          // constructPath args: [subOps, subArgs, minMax]
          const minMax = args[2] as number[] | undefined;
          if (minMax && minMax.length >= 4) {
            const [minX, minY, maxX, maxY] = minMax;
            // Transform path bbox corners through CTM
            const corners = [
              [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY],
            ];
            let txMin = Infinity, tyMin = Infinity, txMax = -Infinity, tyMax = -Infinity;
            for (const [cx, cy] of corners) {
              const tx = currentTransform[0] * cx + currentTransform[2] * cy + currentTransform[4];
              const ty = currentTransform[1] * cx + currentTransform[3] * cy + currentTransform[5];
              txMin = Math.min(txMin, tx);
              tyMin = Math.min(tyMin, ty);
              txMax = Math.max(txMax, tx);
              tyMax = Math.max(tyMax, ty);
            }
            const w = txMax - txMin;
            const h = tyMax - tyMin;
            if (w > 0.5 && h > 0.5) { // Skip sub-pixel paths (hairlines, dots)
              const topY = viewport.height - tyMax;
              if (mergeBBox(activeMcid, { x: txMin, y: topY, w, h })) {
                pathMapped++;
              }
            }
          }
        }
      }
    }
  }

  return { imagesMapped, textMapped, pathMapped };
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
        // Emit ghost zone — structure element exists but bbox not computable
        zones.push({
          pageNumber: pageNum,
          bbox: null,
          zoneType,
          confidence: 0,
          label: resolvedTag,
          isGhost: true,
          ghostTag: rawTag,
        });
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

  const textMcidCount = [...mcidMap.entries()].reduce((sum, [, m]) => sum + m.size, 0);

  // 4b. Augment with ALL content types from operator list (text, images, paths)
  const opStats = await augmentMcidMapFromOperatorList(pdfjsDoc, mcidMap);
  await pdfjsDoc.destroy();

  const totalFromOpList = opStats.textMapped + opStats.imagesMapped + opStats.pathMapped;
  logger.info(
    `[tagged-pdf-extractor] MCID bbox map: ${textMcidCount} from textContent + ${totalFromOpList} from operatorList ` +
    `(text:${opStats.textMapped} img:${opStats.imagesMapped} path:${opStats.pathMapped}) across ${mcidMap.size} pages`,
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

  // Page classification
  const { classifyPages } = await import('./page-classifier');
  const realZones = zones.filter((z) => !z.isGhost && z.bbox);
  const pageClassifications = classifyPages(
    realZones.map((z) => ({
      pageNumber: z.pageNumber,
      zoneType: z.zoneType,
      label: z.label,
      bbox: z.bbox,
      isGhost: z.isGhost,
    })),
    totalPages,
  );

  const ghostCount = zones.filter((z) => z.isGhost).length;

  logger.info(
    `[tagged-pdf-extractor] Page types: ${pageClassifications.filter((p) => p.pageType !== 'body').map((p) => `p${p.pageNumber}=${p.pageType}`).join(', ') || 'all body'}`,
  );

  return {
    jobId: calibrationRunId,
    zones,
    processingTimeMs: Date.now() - startTime,
    extractionStats: {
      structElements: stats.structElements,
      zonesExtracted: realZones.length,
      ghostZones: ghostCount,
      textMcids: textMcidCount,
      imageMcids: opStats.imagesMapped,
      opListTextMcids: opStats.textMapped,
      opListPathMcids: opStats.pathMapped,
      droppedNoBbox: stats.droppedNoBbox,
      unmappedTags: Object.fromEntries(stats.unmappedTags),
      pagesWithZeroZones: emptyPages,
      pageClassifications,
    },
  };
}
