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
 * Covers ALL standard PDF 1.7 (ISO 32000-1) and PDF 2.0 (ISO 32000-2)
 * structure tags plus common custom aliases.
 */
const TAG_MAP: Record<string, CanonicalZoneType> = {
  // ── Block-level text ──────────────────────────────────
  'P':          'paragraph',
  'BlockQuote': 'paragraph',
  'Code':       'paragraph',
  'BibEntry':   'paragraph',
  'Formula':    'paragraph',
  // ── Inline text (absorbed into parent block) ──────────
  'Span':       'paragraph',
  'Quote':      'paragraph',
  'Em':         'paragraph',
  'Strong':     'paragraph',
  'Sub':        'paragraph',
  'NonStruct':  'paragraph',
  'Private':    'paragraph',
  // ── Headings ──────────────────────────────────────────
  'H':          'section-header',
  'H1':         'section-header',
  'H2':         'section-header',
  'H3':         'section-header',
  'H4':         'section-header',
  'H5':         'section-header',
  'H6':         'section-header',
  'H7':         'section-header',
  'Title':      'section-header',
  // ── Tables ────────────────────────────────────────────
  'Table':      'table',
  'TR':         'table',
  'TH':         'table',
  'TD':         'table',
  'TBody':      'table',
  // ── Figures / illustrations ───────────────────────────
  'Figure':     'figure',
  'Form':       'figure',
  // ── Captions ──────────────────────────────────────────
  'Caption':    'caption',
  // ── Notes / footnotes ─────────────────────────────────
  'Note':       'footnote',
  'NT':         'footnote',
  'FENote':     'footnote',
  // ── Container / grouping ──────────────────────────────
  'Sect':       'paragraph',
  'Div':        'paragraph',
  'Art':        'paragraph',
  'Part':       'paragraph',
  'Aside':      'paragraph',
  'Index':      'paragraph',
  // ── Headers / footers (running) ───────────────────────
  'THead':      'header',
  'TFoot':      'footer',
  'Hdr':        'header',
  'FTR':        'footer',
  'Header':     'header',
  'Footer':     'footer',
  // ── TOC ───────────────────────────────────────────────
  'TOC':        'paragraph',
  'TOCI':       'paragraph',
  // ── Lists ─────────────────────────────────────────────
  'L':          'paragraph',
  'LI':         'paragraph',
  'Lbl':        'paragraph',
  'LBody':      'paragraph',
  // ── Annotations / links ───────────────────────────────
  'Annot':      'paragraph',
  'Link':       'paragraph',
  'Reference':  'paragraph',
  // ── Ruby / Warichu (CJK inline) ──────────────────────
  'Ruby':       'paragraph',
  'RB':         'paragraph',
  'RT':         'paragraph',
  'RP':         'paragraph',
  'Warichu':    'paragraph',
  'WT':         'paragraph',
  'WP':         'paragraph',
};

// ─── Block-level semantic extraction ────────────────────────────────────
// Three tag categories control the tree walk strategy:
//
// ZONE_TAGS:      Emit a zone, collect ALL descendant content, stop recursing.
//                 These are meaningful content blocks (paragraphs, headings, etc.)
//
// CONTAINER_TAGS: Don't emit a zone — just recurse into children.
//                 These are structural grouping elements.
//
// Everything else is INLINE (Span, Link, Em, Lbl, etc.) — absorbed into
// the nearest ancestor zone. If encountered at the top level with no
// block ancestor, emitted as a fallback paragraph zone.

/** Tags that emit a zone and collect ALL descendant content IDs. */
const ZONE_TAGS = new Set([
  // Block text
  'P', 'BlockQuote', 'Code', 'BibEntry', 'Formula',
  // Headings
  'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'Title',
  // Tables (whole table = one zone)
  'Table',
  // Figures
  'Figure', 'Form',
  // Captions
  'Caption',
  // Notes / footnotes
  'Note', 'NT', 'FENote',
  // List items (each LI = one zone, absorbs Lbl + LBody)
  'LI',
  // Headers / footers
  'Hdr', 'FTR', 'Header', 'Footer', 'THead', 'TFoot',
  // TOC entries
  'TOCI',
]);

/** Tags that are transparent containers — recurse into children, no zone. */
const CONTAINER_TAGS = new Set([
  'Root', 'Document', 'StructTreeRoot', 'DocumentFragment',
  'Sect', 'Div', 'Art', 'Part', 'Aside', 'Index',
  'L',      // list: recurse into LI items
  'LBody',  // list item body: may contain P or inline content
  'TOC',    // TOC: recurse into TOCI entries
  'TR', 'TBody', // table internals (Table already captured if above)
  'NonStruct', 'Private',
]);

/**
 * Resolve a tag name through a RoleMap, then look up in TAG_MAP.
 * RoleMap maps custom tag names to standard tags (e.g. Title → H1).
 * Unknown tags default to 'paragraph' — never silently dropped.
 */
export function mapStructTag(
  tag: string,
  roleMap?: Map<string, string>,
): CanonicalZoneType | null {
  const resolvedTag = roleMap?.get(tag) ?? tag;
  if (CONTAINER_TAGS.has(resolvedTag)) return null;
  return TAG_MAP[resolvedTag] ?? 'paragraph';
}

export interface TaggedPdfZone {
  pageNumber: number;
  bbox: BBox | null;
  zoneType: CanonicalZoneType;
  confidence: number;
  label: string;
  content?: string;    // text content collected from descendant content IDs
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
  extractionMethod: 'structTreeApi' | 'pdfLibFallback';
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

// ═══════════════════════════════════════════════════════════════════════
// PRIMARY EXTRACTION: pdfjs getStructTree() + getTextContent()
//
// Uses pdfjs's built-in per-page structure tree API which:
// - Returns roles already resolved through RoleMap
// - Uses full content IDs (p{objRef}_mc{mcid}) that correctly identify
//   content in Form XObjects vs page content streams
// - Matched against getTextContent() which uses the same ID format
// ═══════════════════════════════════════════════════════════════════════

/** Content-ID-based bbox map. Key: full pdfjs content ID (e.g., "p44R_mc5"). */
type ContentIdBBoxMap = Map<string, BBox>;

interface PdfjsStructNode {
  role: string;
  children: (PdfjsStructNode | PdfjsStructContent)[];
  alt?: string;
  bbox?: number[];
  lang?: string;
}

interface PdfjsStructContent {
  type: 'content' | 'object' | 'annotation';
  id: string;
}

function isPdfjsStructNode(child: unknown): child is PdfjsStructNode {
  return typeof child === 'object' && child !== null && 'role' in child;
}

function isPdfjsContent(child: unknown): child is PdfjsStructContent {
  return typeof child === 'object' && child !== null && 'type' in child && 'id' in child;
}

/** Extraction stats for the struct tree API approach. */
interface StructTreeApiStats {
  structElements: number;
  unmappedTags: Map<string, number>;
  contentIdsFound: number;
  contentIdsWithBbox: number;
  bboxFromExplicit: number;
  droppedNoBbox: number;
  opListText: number;
  opListImage: number;
  opListPath: number;
}

/** Maps content ID → max font size seen in that content run. */
type ContentIdFontMap = Map<string, number>;

/** Maps content ID → accumulated text strings. */
type ContentIdTextMap = Map<string, string[]>;

interface ContentIdMaps {
  bboxMap: ContentIdBBoxMap;
  fontMap: ContentIdFontMap;
  textMap: ContentIdTextMap;
}

/**
 * Build content-ID → bbox map (and font size map) from getTextContent().
 * Uses full pdfjs content IDs (e.g., "p44R_mc5") to correctly handle
 * MCIDs from both page content streams AND Form XObjects.
 */
async function buildContentIdBBoxMap(
  page: pdfjsLib.PDFPageProxy,
): Promise<ContentIdMaps> {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  const bboxMap: ContentIdBBoxMap = new Map();
  const fontMap: ContentIdFontMap = new Map();
  const textMap: ContentIdTextMap = new Map();

  const idStack: string[] = [];

  for (const item of textContent.items) {
    if ('type' in item) {
      const mc = item as unknown as { type: string; id?: string };
      if (mc.type === 'beginMarkedContent' || mc.type === 'beginMarkedContentProps') {
        idStack.push(mc.id || '');
      } else if (mc.type === 'endMarkedContent') {
        idStack.pop();
      }
      continue;
    }

    // Regular text item
    const textItem = item as {
      str: string;
      transform: number[];
      width: number;
      height: number;
    };
    if (!textItem.transform) continue;

    // Find innermost content ID
    let activeId = '';
    for (let i = idStack.length - 1; i >= 0; i--) {
      if (idStack[i]) { activeId = idStack[i]; break; }
    }
    if (!activeId) continue;

    const x = textItem.transform[4];
    const y = textItem.transform[5];
    const fontSize = Math.abs(textItem.transform[0]);
    const w = textItem.width;
    const h = fontSize || textItem.height;
    const topY = viewport.height - y - h;

    mergeBBoxIntoMap(bboxMap, activeId, { x, y: topY, w, h });
    // Track max font size per content ID (for heading level inference)
    if (fontSize > 0) {
      fontMap.set(activeId, Math.max(fontMap.get(activeId) ?? 0, fontSize));
    }
    // Accumulate text content per content ID
    if (textItem.str) {
      const existing = textMap.get(activeId);
      if (existing) {
        existing.push(textItem.str);
      } else {
        textMap.set(activeId, [textItem.str]);
      }
    }
  }

  return { bboxMap, fontMap, textMap };
}

/**
 * Cluster bboxes by vertical proximity into paragraph-level groups.
 * Merges bboxes whose vertical gap is less than LINE_GAP_THRESHOLD.
 */
function clusterBboxesByProximity(bboxes: BBox[]): BBox[] {
  if (bboxes.length === 0) return [];
  // Sort by Y position (top to bottom)
  const sorted = [...bboxes].sort((a, b) => a.y - b.y);

  // Estimate typical line height from the median height of all bboxes
  const heights = sorted.map((b) => b.h).filter((h) => h > 0).sort((a, b) => a - b);
  const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 12;
  const gapThreshold = medianHeight * 2.0;

  const clusters: BBox[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const box = sorted[i];
    const currentBottom = current.y + current.h;
    const gap = box.y - currentBottom;

    if (gap < gapThreshold) {
      // Merge into current cluster
      const x2 = Math.max(current.x + current.w, box.x + box.w);
      const y2 = Math.max(currentBottom, box.y + box.h);
      current.x = Math.min(current.x, box.x);
      current.w = x2 - current.x;
      current.h = y2 - current.y;
    } else {
      // Start new cluster
      clusters.push(current);
      current = { ...box };
    }
  }
  clusters.push(current);
  return clusters;
}

function mergeBBoxIntoMap(map: Map<string, BBox>, key: string, bbox: BBox): void {
  const existing = map.get(key);
  if (existing) {
    const x2 = Math.max(existing.x + existing.w, bbox.x + bbox.w);
    const y2 = Math.max(existing.y + existing.h, bbox.y + bbox.h);
    existing.x = Math.min(existing.x, bbox.x);
    existing.y = Math.min(existing.y, bbox.y);
    existing.w = x2 - existing.x;
    existing.h = y2 - existing.y;
  } else {
    map.set(key, { ...bbox });
  }
}

// ── Operator-list augmentation for content IDs ──────────────────────

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

/**
 * Augment the content-ID bbox map with content from getOperatorList().
 * Captures text draws, images, and paths within marked content sections
 * that getTextContent() missed.
 *
 * Uses the page's object ID to construct content IDs matching the format
 * from getStructTree() (p{objId}_mc{mcid}).
 */
async function augmentContentIdMapFromOperatorList(
  page: pdfjsLib.PDFPageProxy,
  map: ContentIdBBoxMap,
): Promise<{ text: number; image: number; path: number; mcidBboxMap: Map<number, BBox> }> {
  const OPS = pdfjsLib.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();

  const fnArray = opList.fnArray as number[];
  const argsArray = opList.argsArray as unknown[][];

  // Track Form XObject nesting to construct correct content IDs
  // pdfjs serializes content IDs as p{pageObjId}_mc{mcid}
  // We need the page/FormXObj object reference
  // First try page.ref, then discover from existing text content IDs in map
  const pageRef = (page as unknown as { ref?: { num: number; gen: number } }).ref;
  let pageObjId = pageRef ? `${pageRef.num}R` : '';
  if (!pageObjId) {
    // Discover page object ID from existing text content map keys
    for (const key of map.keys()) {
      const m = key.match(/^p(.+?)_mc\d+$/);
      if (m) { pageObjId = m[1]; break; }
    }
    if (!pageObjId) pageObjId = `page${page.pageNumber}`;
  }
  const objIdStack: string[] = [pageObjId];

  // Secondary map: MCID → image/path bbox (fallback for Form XObject ID mismatches)
  const mcidBboxMap = new Map<number, BBox>();

  const mcidStack: number[] = [];
  const transformStack: number[][] = [];
  let currentTransform = [1, 0, 0, 1, 0, 0];

  let textMatrix = [1, 0, 0, 1, 0, 0];
  let textLineMatrix = [1, 0, 0, 1, 0, 0];
  let fontSize = 12;
  let leading = 0;

  let textMapped = 0;
  let imageMapped = 0;
  let pathMapped = 0;

  function getCurrentContentId(mcid: number): string {
    const objId = objIdStack[objIdStack.length - 1] || pageObjId;
    return `p${objId}_mc${mcid}`;
  }

  function getNewActiveMcid(): { mcid: number; contentId: string } | null {
    for (let j = mcidStack.length - 1; j >= 0; j--) {
      if (mcidStack[j] >= 0) {
        const contentId = getCurrentContentId(mcidStack[j]);
        if (map.has(contentId)) return null; // already have bbox from text content
        return { mcid: mcidStack[j], contentId };
      }
    }
    return null;
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    // Graphics state
    if (fn === OPS.save) {
      transformStack.push([...currentTransform]);
    } else if (fn === OPS.restore) {
      if (transformStack.length > 0) currentTransform = transformStack.pop()!;
    } else if (fn === OPS.transform) {
      currentTransform = multiplyTransforms(currentTransform, args as number[]);
    }
    // Form XObject nesting
    else if (fn === OPS.paintFormXObjectBegin) {
      // Push a new object ID context — use the matrix as a rough identifier
      // pdfjs doesn't expose the XObject ref here, but we can infer from patterns
      objIdStack.push(`xobj_${i}`);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (objIdStack.length > 1) objIdStack.pop();
    }
    // Marked content
    else if (fn === OPS.beginMarkedContent) {
      mcidStack.push(-1);
    } else if (fn === OPS.beginMarkedContentProps) {
      const props = args[1] as Record<string, unknown> | undefined;
      const mcid = typeof props?.mcid === 'number' ? props.mcid : -1;
      mcidStack.push(mcid);
    } else if (fn === OPS.endMarkedContent) {
      mcidStack.pop();
    }
    // Text state
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
      textLineMatrix = [
        textLineMatrix[0], textLineMatrix[1],
        textLineMatrix[2], textLineMatrix[3],
        textLineMatrix[2] * (-leading) + textLineMatrix[4],
        textLineMatrix[3] * (-leading) + textLineMatrix[5],
      ];
      textMatrix = [...textLineMatrix];
    }
    // Text drawing
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const active = getNewActiveMcid();
      if (active) {
        const tm = multiplyTransforms(currentTransform, textMatrix);
        const x = tm[4];
        const y = tm[5];
        const scaledFontSize = Math.abs(tm[3]) || Math.abs(fontSize * Math.abs(currentTransform[3])) || fontSize;

        let estWidth = 0;
        const glyphs = args[0];
        if (Array.isArray(glyphs)) {
          for (const g of glyphs) {
            if (typeof g === 'object' && g !== null && 'width' in g) {
              estWidth += ((g as { width: number }).width * fontSize) / 1000;
            } else if (typeof g === 'number') {
              estWidth -= (g * fontSize) / 1000;
            }
          }
        }
        if (estWidth <= 0) estWidth = scaledFontSize * 3;

        const h = scaledFontSize;
        const topY = viewport.height - y - h;
        const isNew = !map.has(active.contentId);
        mergeBBoxIntoMap(map, active.contentId, { x, y: topY, w: Math.abs(estWidth), h });
        if (isNew) textMapped++;
      }

      // Advance text matrix
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
      textLineMatrix = [
        textLineMatrix[0], textLineMatrix[1],
        textLineMatrix[2], textLineMatrix[3],
        textLineMatrix[2] * (-leading) + textLineMatrix[4],
        textLineMatrix[3] * (-leading) + textLineMatrix[5],
      ];
      textMatrix = [...textLineMatrix];

      const active = getNewActiveMcid();
      if (active) {
        const tm = multiplyTransforms(currentTransform, textMatrix);
        const x = tm[4];
        const y = tm[5];
        const scaledFontSize = Math.abs(tm[3]) || fontSize;
        const topY = viewport.height - y - scaledFontSize;
        const isNew = !map.has(active.contentId);
        mergeBBoxIntoMap(map, active.contentId, { x, y: topY, w: scaledFontSize * 5, h: scaledFontSize });
        if (isNew) textMapped++;
      }
    }
    // Images — always store in mcidBboxMap as fallback for Form XObject ID mismatches
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const activeMcid = mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : -1;
      const active = getNewActiveMcid();
      const [a, b, c, d, e, f] = currentTransform;
      const width = Math.sqrt(a * a + b * b);
      const height = Math.sqrt(c * c + d * d);
      const x = e;
      const y = viewport.height - f - height;
      const imgBbox = { x, y, w: width, h: height };

      if (active) {
        const isNew = !map.has(active.contentId);
        mergeBBoxIntoMap(map, active.contentId, imgBbox);
        if (isNew) imageMapped++;
      }
      // Always store by raw MCID for fallback lookup (Form XObject ID mismatches)
      if (activeMcid >= 0) {
        const existing = mcidBboxMap.get(activeMcid);
        if (!existing) {
          mcidBboxMap.set(activeMcid, { ...imgBbox });
        } else {
          const x2 = Math.max(existing.x + existing.w, imgBbox.x + imgBbox.w);
          const y2 = Math.max(existing.y + existing.h, imgBbox.y + imgBbox.h);
          existing.x = Math.min(existing.x, imgBbox.x);
          existing.y = Math.min(existing.y, imgBbox.y);
          existing.w = x2 - existing.x;
          existing.h = y2 - existing.y;
        }
      }
    }
    // Paths
    else if (fn === OPS.constructPath) {
      const active = getNewActiveMcid();
      if (active) {
        const minMax = args[2] as number[] | undefined;
        if (minMax && minMax.length >= 4) {
          const [minX, minY, maxX, maxY] = minMax;
          const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
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
          if (w > 0.5 && h > 0.5) {
            const isNew = !map.has(active.contentId);
            mergeBBoxIntoMap(map, active.contentId, { x: txMin, y: viewport.height - tyMax, w, h });
            if (isNew) pathMapped++;
          }
        }
      }
    }
  }

  return { text: textMapped, image: imageMapped, path: pathMapped, mcidBboxMap };
}

/**
 * Recursively collect ALL descendant content IDs from a structure node.
 * Walks through inline children (Span, Link, etc.) to capture content
 * that is nested inside inline wrappers.
 */
function collectAllDescendantContentIds(
  node: PdfjsStructNode,
  depth: number = 0,
): string[] {
  if (depth > 100) return [];
  const ids: string[] = [];
  for (const child of node.children || []) {
    if (isPdfjsContent(child) && (child.type === 'content' || child.type === 'object')) {
      ids.push(child.id);
    } else if (isPdfjsStructNode(child)) {
      ids.push(...collectAllDescendantContentIds(child, depth + 1));
    }
  }
  return ids;
}

/**
 * Compute a merged bbox from a list of content IDs using the bbox map.
 */
function bboxFromContentIds(
  contentIds: string[],
  idBBoxMap: ContentIdBBoxMap,
): { bbox: BBox | null; matched: number } {
  let bbox: BBox | null = null;
  let matched = 0;
  for (const id of contentIds) {
    const itemBBox = idBBoxMap.get(id);
    if (itemBBox) {
      matched++;
      if (!bbox) {
        bbox = { ...itemBBox };
      } else {
        const x2 = Math.max(bbox.x + bbox.w, itemBBox.x + itemBBox.w);
        const y2 = Math.max(bbox.y + bbox.h, itemBBox.y + itemBBox.h);
        bbox.x = Math.min(bbox.x, itemBBox.x);
        bbox.y = Math.min(bbox.y, itemBBox.y);
        bbox.w = x2 - bbox.x;
        bbox.h = y2 - bbox.y;
      }
    }
  }
  return { bbox, matched };
}

/**
 * Dump the pdfjs structure tree for a page (diagnostic logging).
 * Only logs the first maxDepth levels to keep output manageable.
 */
function dumpStructTree(node: PdfjsStructNode, maxDepth = 4, indent = 0): string {
  if (indent > maxDepth) return '';
  const prefix = '  '.repeat(indent);
  const role = node.role ?? '(root)';
  const children = node.children || [];
  const structCount = children.filter((c) => isPdfjsStructNode(c)).length;
  const contentCount = children.filter((c) => isPdfjsContent(c)).length;
  let line = `${prefix}${role} [struct:${structCount} content:${contentCount}]`;
  const lines = [line];
  for (const child of children) {
    if (isPdfjsStructNode(child)) {
      lines.push(dumpStructTree(child, maxDepth, indent + 1));
    }
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Walk the pdfjs structure tree for a page and extract zones.
 *
 * Uses a "block-level semantic" approach:
 * - ZONE_TAGS (P, H1-H6, Table, LI, Figure, etc.) emit a zone, collect
 *   ALL descendant content IDs, and stop recursing. One block = one zone.
 * - CONTAINER_TAGS (Sect, Div, L, etc.) are transparent — just recurse
 *   into children. Any orphan direct content emitted as fallback.
 * - INLINE tags (Span, Link, Em, Lbl, etc.) are absorbed into their
 *   parent zone. If encountered at the top level (no block ancestor),
 *   they emit a fallback paragraph zone.
 *
 * This matches how native pdfxt extracts: semantic blocks like P, H2,
 * H3, Table — not fragmented inline elements.
 */
function walkPdfjsStructTree(
  node: PdfjsStructNode,
  pageNum: number,
  idBBoxMap: ContentIdBBoxMap,
  zones: TaggedPdfZone[],
  stats: StructTreeApiStats,
  claimedIds: Set<string>,
  depth: number,
  mcidBboxMap?: Map<number, BBox>,
  textMap?: ContentIdTextMap,
): void {
  if (depth > 100) return;

  const role = node.role;
  if (!role) {
    for (const child of node.children || []) {
      if (isPdfjsStructNode(child)) {
        walkPdfjsStructTree(child, pageNum, idBBoxMap, zones, stats, claimedIds, depth + 1, mcidBboxMap, textMap);
      }
    }
    return;
  }

  // ── CONTAINER TAG — recurse into children, no zone ──
  if (CONTAINER_TAGS.has(role)) {
    for (const child of node.children || []) {
      if (isPdfjsStructNode(child)) {
        walkPdfjsStructTree(child, pageNum, idBBoxMap, zones, stats, claimedIds, depth + 1, mcidBboxMap, textMap);
      }
    }
    // Emit orphan direct content not claimed by children
    emitOrphanContent(node, role, pageNum, idBBoxMap, zones, stats, claimedIds);
    return;
  }

  // ── ZONE TAG — emit one zone, collect ALL descendants, stop recursing ──
  if (ZONE_TAGS.has(role)) {
    emitBlockZone(node, role, pageNum, idBBoxMap, zones, stats, claimedIds, mcidBboxMap, textMap);
    return;
  }

  // ── INLINE TAG at top level (no block ancestor captured it) ──
  // This happens when inline elements appear directly under containers.
  // Emit as a fallback zone so nothing is lost.
  emitBlockZone(node, role, pageNum, idBBoxMap, zones, stats, claimedIds, mcidBboxMap, textMap);
}

/**
 * Emit a single zone for a block-level element, collecting ALL
 * descendant content IDs into one merged bbox.
 */
function emitBlockZone(
  node: PdfjsStructNode,
  role: string,
  pageNum: number,
  idBBoxMap: ContentIdBBoxMap,
  zones: TaggedPdfZone[],
  stats: StructTreeApiStats,
  claimedIds: Set<string>,
  mcidBboxMap?: Map<number, BBox>,
  textMap?: ContentIdTextMap,
): void {
  const zoneType = TAG_MAP[role] ?? 'paragraph';
  const allContentIds = collectAllDescendantContentIds(node);

  stats.structElements++;
  stats.contentIdsFound += allContentIds.length;

  if (allContentIds.length > 0) {
    const { bbox, matched } = bboxFromContentIds(allContentIds, idBBoxMap);
    if (matched > 0) stats.contentIdsWithBbox += matched;

    // Fallback 1: MCID-only lookup from operator list (fixes Form XObject ID mismatches)
    let finalBBox = bbox;
    if (!finalBBox && mcidBboxMap && mcidBboxMap.size > 0) {
      for (const id of allContentIds) {
        const mcidMatch = id.match(/_mc(\d+)$/);
        if (mcidMatch) {
          const mcid = parseInt(mcidMatch[1], 10);
          const mcidBbox = mcidBboxMap.get(mcid);
          if (mcidBbox) {
            if (!finalBBox) {
              finalBBox = { ...mcidBbox };
            } else {
              const x2 = Math.max(finalBBox.x + finalBBox.w, mcidBbox.x + mcidBbox.w);
              const y2 = Math.max(finalBBox.y + finalBBox.h, mcidBbox.y + mcidBbox.h);
              finalBBox.x = Math.min(finalBBox.x, mcidBbox.x);
              finalBBox.y = Math.min(finalBBox.y, mcidBbox.y);
              finalBBox.w = x2 - finalBBox.x;
              finalBBox.h = y2 - finalBBox.y;
            }
          }
        }
      }
      if (finalBBox && !bbox) {
        logger.debug(`[tagged-pdf-extractor] MCID fallback resolved bbox for ${role} zone on page ${pageNum} (${allContentIds.length} IDs)`);
      }
    }

    // Fallback 2: explicit bbox from pdfjs attributes
    if (!finalBBox && node.bbox && node.bbox.length >= 4) {
      finalBBox = {
        x: Math.min(node.bbox[0], node.bbox[2]),
        y: Math.min(node.bbox[1], node.bbox[3]),
        w: Math.abs(node.bbox[2] - node.bbox[0]),
        h: Math.abs(node.bbox[3] - node.bbox[1]),
      };
      stats.bboxFromExplicit++;
    }

    // Collect text content from all descendant content IDs
    let content: string | undefined;
    if (textMap) {
      const textParts: string[] = [];
      for (const id of allContentIds) {
        const parts = textMap.get(id);
        if (parts) textParts.push(parts.join(''));
      }
      const joined = textParts.join(' ').trim();
      if (joined) content = joined;
    }

    if (finalBBox) {
      zones.push({ pageNumber: pageNum, bbox: finalBBox, zoneType, confidence: 0.9, label: role, content });
      for (const id of allContentIds) claimedIds.add(id);
    } else {
      stats.droppedNoBbox++;
      zones.push({
        pageNumber: pageNum, bbox: null, zoneType, confidence: 0,
        label: role, isGhost: true, ghostTag: role, content,
      });
    }
  } else {
    // Element with no content IDs — try MCID fallback for object/annotation children
    const objectChildren = (node.children || []).filter(
      (c) => isPdfjsContent(c) && (c.type === 'object' || c.type === 'annotation'),
    ) as PdfjsStructContent[];

    if (objectChildren.length > 0) {
      // Try to resolve bbox from MCID fallback map using object child IDs
      let objBbox: BBox | null = null;
      if (mcidBboxMap && mcidBboxMap.size > 0) {
        for (const child of objectChildren) {
          const mcidMatch = child.id.match(/_mc(\d+)$/);
          if (mcidMatch) {
            const mcid = parseInt(mcidMatch[1], 10);
            const mcidBbox = mcidBboxMap.get(mcid);
            if (mcidBbox) {
              if (!objBbox) {
                objBbox = { ...mcidBbox };
              } else {
                const x2 = Math.max(objBbox.x + objBbox.w, mcidBbox.x + mcidBbox.w);
                const y2 = Math.max(objBbox.y + objBbox.h, mcidBbox.y + mcidBbox.h);
                objBbox.x = Math.min(objBbox.x, mcidBbox.x);
                objBbox.y = Math.min(objBbox.y, mcidBbox.y);
                objBbox.w = x2 - objBbox.x;
                objBbox.h = y2 - objBbox.y;
              }
            }
          }
        }
      }

      if (objBbox) {
        logger.debug(`[tagged-pdf-extractor] MCID fallback resolved object-child bbox for ${role} on page ${pageNum}`);
        zones.push({ pageNumber: pageNum, bbox: objBbox, zoneType, confidence: 0.85, label: role });
      } else {
        stats.structElements++;
        stats.droppedNoBbox++;
        zones.push({
          pageNumber: pageNum, bbox: null, zoneType, confidence: 0,
          label: role, isGhost: true, ghostTag: role,
        });
      }
    }
  }
}

/**
 * Emit a fallback zone for orphan direct content in a container node
 * that wasn't claimed by any child struct element.
 */
function emitOrphanContent(
  node: PdfjsStructNode,
  role: string,
  pageNum: number,
  idBBoxMap: ContentIdBBoxMap,
  zones: TaggedPdfZone[],
  stats: StructTreeApiStats,
  claimedIds: Set<string>,
): void {
  const directContentIds: string[] = [];
  for (const child of node.children || []) {
    if (isPdfjsContent(child) && (child.type === 'content' || child.type === 'object')) {
      directContentIds.push(child.id);
    }
  }
  if (directContentIds.length === 0) return;

  const orphanIds = directContentIds.filter((id) => !claimedIds.has(id));
  if (orphanIds.length === 0) return;

  const zoneType = TAG_MAP[role] ?? 'paragraph';
  stats.structElements++;
  stats.contentIdsFound += orphanIds.length;
  const { bbox, matched } = bboxFromContentIds(orphanIds, idBBoxMap);
  if (matched > 0) stats.contentIdsWithBbox += matched;
  if (bbox) {
    zones.push({ pageNumber: pageNum, bbox, zoneType, confidence: 0.85, label: role });
    for (const id of orphanIds) claimedIds.add(id);
  }
}

/**
 * Primary extraction using pdfjs getStructTree() API.
 * Returns null if the PDF doesn't support this API (no ParentTree).
 */
async function extractUsingStructTreeApi(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
): Promise<{ zones: TaggedPdfZone[]; stats: StructTreeApiStats } | null> {
  const zones: TaggedPdfZone[] = [];
  const stats: StructTreeApiStats = {
    structElements: 0,
    unmappedTags: new Map(),
    contentIdsFound: 0,
    contentIdsWithBbox: 0,
    bboxFromExplicit: 0,
    droppedNoBbox: 0,
    opListText: 0,
    opListImage: 0,
    opListPath: 0,
  };

  let hasAnyStructTree = false;
  const pageFontSizes = new Set<number>(); // collect all font sizes for heading inference

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    const page = await pdfjsDoc.getPage(pageNum);

    // Get the per-page structure tree (roles already resolved via RoleMap)
    const structTree = await page.getStructTree();
    if (!structTree || !structTree.children || structTree.children.length === 0) {
      continue;
    }
    hasAnyStructTree = true;

    // Dump struct tree for first page (diagnostic)
    if (pageNum <= 2) {
      const treeDump = dumpStructTree(structTree as unknown as PdfjsStructNode, 3);
      logger.info(`[tagged-pdf-extractor] Page ${pageNum} struct tree:\n${treeDump}`);
    }

    // Build content-ID → bbox map, font size map, and text map from text content
    const { bboxMap: idBBoxMap, fontMap, textMap } = await buildContentIdBBoxMap(page);

    // Augment with operator list for non-text content (images, paths, missed text)
    const opStats = await augmentContentIdMapFromOperatorList(page, idBBoxMap);
    stats.opListText += opStats.text;
    stats.opListImage += opStats.image;
    stats.opListPath += opStats.path;

    if (opStats.mcidBboxMap.size > 0) {
      logger.info(`[tagged-pdf-extractor] Page ${pageNum}: mcidBboxMap has ${opStats.mcidBboxMap.size} image/path entries (fallback for figure detection)`);
    }

    // Collect all font sizes on this page for heading level inference
    for (const [, size] of fontMap) {
      if (size > 0) pageFontSizes.add(size);
    }

    // Walk the structure tree and extract zones
    const claimedIds = new Set<string>();
    walkPdfjsStructTree(
      structTree as unknown as PdfjsStructNode,
      pageNum,
      idBBoxMap,
      zones,
      stats,
      claimedIds,
      0,
      opStats.mcidBboxMap,
      textMap,
    );

    // Recover orphan content IDs — content in bbox map not claimed by any struct element.
    // Cluster nearby orphans into paragraph-level zones instead of emitting one per content ID.
    const orphanBboxes: BBox[] = [];
    for (const [contentId, bbox] of idBBoxMap.entries()) {
      if (!claimedIds.has(contentId)) {
        orphanBboxes.push(bbox);
      }
    }
    const orphanClusters = clusterBboxesByProximity(orphanBboxes);
    for (const cluster of orphanClusters) {
      zones.push({
        pageNumber: pageNum,
        bbox: cluster,
        zoneType: 'paragraph',
        confidence: 0.7,
        label: 'Orphan',
      });
    }

    const treeZones = zones.filter((z) => z.pageNumber === pageNum && z.label !== 'Orphan').length;
    logger.info(
      `[tagged-pdf-extractor] Page ${pageNum}: bboxMap=${idBBoxMap.size} claimed=${claimedIds.size} treeZones=${treeZones} orphanClusters=${orphanClusters.length} (from ${orphanBboxes.length} IDs)`,
    );
  }

  if (!hasAnyStructTree) return null;

  // Post-process: infer heading levels for generic "H" tags using font sizes
  inferHeadingLevels(zones, pageFontSizes);

  // Post-process: absorb orphan captions into adjacent figure zones
  absorbCaptionsIntoFigures(zones);

  return { zones, stats };
}

/**
 * For zones tagged as generic "H", infer H1-H6 from font size.
 * Builds a descending list of distinct font sizes found in the document,
 * then maps each heading's font size to a level (largest = H1, etc.).
 */
function inferHeadingLevels(
  zones: TaggedPdfZone[],
  allFontSizes: Set<number>,
): void {
  const genericH = zones.filter((z) => z.label === 'H' && z.zoneType === 'section-header');
  if (genericH.length === 0) return;

  // Build distinct font sizes sorted descending (largest first)
  const sortedSizes = [...allFontSizes].filter((s) => s > 0).sort((a, b) => b - a);
  if (sortedSizes.length === 0) return;

  // Compute body text font size (most common — typically the smallest among frequent sizes)
  // Use the median font size as a proxy; anything larger is a heading candidate
  const bodySize = sortedSizes.length > 2 ? sortedSizes[Math.floor(sortedSizes.length / 2)] : sortedSizes[sortedSizes.length - 1];

  // Only consider sizes above body text as heading sizes
  const headingSizes = sortedSizes.filter((s) => s > bodySize);
  if (headingSizes.length === 0) {
    // All same size — can't distinguish, leave as H
    return;
  }

  // Map font size → heading level (H1 for largest, H2 for next, etc., max H6)
  const sizeToLevel = new Map<number, number>();
  for (let i = 0; i < headingSizes.length && i < 6; i++) {
    sizeToLevel.set(headingSizes[i], i + 1);
  }

  for (const zone of genericH) {
    // Find the font size for this zone — use bbox height as proxy
    // (heading font size ≈ bbox height for single-line headings)
    const zoneHeight = zone.bbox?.h ?? 0;
    if (zoneHeight <= 0) continue;

    // Find closest matching heading size
    let bestLevel = 6; // default to smallest heading
    let bestDist = Infinity;
    for (const [size, level] of sizeToLevel) {
      const dist = Math.abs(size - zoneHeight);
      if (dist < bestDist) {
        bestDist = dist;
        bestLevel = level;
      }
    }

    zone.label = `H${bestLevel}`;
  }

  const relabeled = genericH.filter((z) => z.label !== 'H').length;
  if (relabeled > 0) {
    logger.info(`[tagged-pdf-extractor] Inferred heading levels for ${relabeled} generic H tags`);
  }
}

/**
 * Absorb orphan caption zones into their nearest figure zone on the same page.
 * A caption is "near" a figure if it overlaps horizontally and is within
 * a small vertical gap (1.5x caption height). The caption's bbox is merged
 * into the figure and the caption zone is removed.
 */
function absorbCaptionsIntoFigures(zones: TaggedPdfZone[]): void {
  const captionIndices: number[] = [];
  const figuresByPage = new Map<number, number[]>();

  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (z.zoneType === 'caption' && z.bbox) {
      captionIndices.push(i);
    }
    if (z.zoneType === 'figure' && z.bbox) {
      const list = figuresByPage.get(z.pageNumber) || [];
      list.push(i);
      figuresByPage.set(z.pageNumber, list);
    }
  }

  if (captionIndices.length === 0) return;

  const toRemove = new Set<number>();

  for (const ci of captionIndices) {
    const cap = zones[ci];
    if (!cap.bbox) continue;
    const figs = figuresByPage.get(cap.pageNumber);
    if (!figs || figs.length === 0) continue;

    // Find nearest figure by vertical proximity with horizontal overlap
    let bestFigIdx = -1;
    let bestDist = Infinity;
    const capRight = cap.bbox.x + cap.bbox.w;
    const capBottom = cap.bbox.y + cap.bbox.h;
    const maxGap = cap.bbox.h * 1.5; // max vertical gap to consider "nearby"

    for (const fi of figs) {
      const fig = zones[fi];
      if (!fig.bbox) continue;

      // Check horizontal overlap (at least 50%)
      const figRight = fig.bbox.x + fig.bbox.w;
      const overlapX = Math.min(capRight, figRight) - Math.max(cap.bbox.x, fig.bbox.x);
      const minWidth = Math.min(cap.bbox.w, fig.bbox.w);
      if (overlapX < minWidth * 0.3) continue;

      // Vertical distance: caption can be above or below figure
      const figBottom = fig.bbox.y + fig.bbox.h;
      let vDist: number;
      if (capBottom <= fig.bbox.y) {
        vDist = fig.bbox.y - capBottom; // caption above figure
      } else if (cap.bbox.y >= figBottom) {
        vDist = cap.bbox.y - figBottom; // caption below figure
      } else {
        vDist = 0; // overlapping vertically
      }

      if (vDist <= maxGap && vDist < bestDist) {
        bestDist = vDist;
        bestFigIdx = fi;
      }
    }

    if (bestFigIdx >= 0) {
      // Merge caption bbox into figure
      const fig = zones[bestFigIdx];
      if (fig.bbox && cap.bbox) {
        const x2 = Math.max(fig.bbox.x + fig.bbox.w, cap.bbox.x + cap.bbox.w);
        const y2 = Math.max(fig.bbox.y + fig.bbox.h, cap.bbox.y + cap.bbox.h);
        fig.bbox.x = Math.min(fig.bbox.x, cap.bbox.x);
        fig.bbox.y = Math.min(fig.bbox.y, cap.bbox.y);
        fig.bbox.w = x2 - fig.bbox.x;
        fig.bbox.h = y2 - fig.bbox.y;
      }
      toRemove.add(ci);
    }
  }

  if (toRemove.size > 0) {
    // Remove absorbed captions (iterate in reverse to preserve indices)
    const sortedRemove = [...toRemove].sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      zones.splice(idx, 1);
    }
    logger.info(`[tagged-pdf-extractor] Absorbed ${toRemove.size} captions into figure zones`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FALLBACK EXTRACTION: pdf-lib StructTreeRoot walking
// Used when getStructTree() returns nothing (no ParentTree in PDF)
// ═══════════════════════════════════════════════════════════════════════

function resolvePdfObj(obj: unknown, doc: PDFDocument): unknown {
  if (obj instanceof PDFRef) return doc.context.lookup(obj);
  return obj;
}

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
    if (stdTag) roleMap.set(customTag, stdTag);
  }

  if (roleMap.size > 0) {
    logger.debug(
      `[tagged-pdf-extractor] RoleMap: ${roleMap.size} entries — ${[...roleMap.entries()].slice(0, 10).map(([k, v]) => `${k}→${v}`).join(', ')}`,
    );
  }
  return roleMap;
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
 * Parse the integer MCID from a pdfjs-dist marked content id string.
 */
function parseMcid(id: string | null | undefined): number {
  if (id == null) return -1;
  const match = id.match(/_mc(\d+)$/);
  if (match) return parseInt(match[1], 10);
  const num = Number(id);
  return isNaN(num) ? -1 : num;
}

type McidBBoxMap = Map<number, Map<number, BBox>>;

async function buildMcidBBoxMap(
  pdfjsDoc: pdfjsLib.PDFDocumentProxy,
): Promise<McidBBoxMap> {
  const pageMap: McidBBoxMap = new Map();

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    const page = await pdfjsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent({ includeMarkedContent: true });

    const mcidStack: number[] = [];
    const mcidBBoxes = new Map<number, BBox>();

    for (const item of textContent.items) {
      if ('type' in item) {
        const mc = item as unknown as { type: string; id?: string };
        if (mc.type === 'beginMarkedContent' || mc.type === 'beginMarkedContentProps') {
          const mcid = parseMcid(mc.id);
          mcidStack.push(mcid >= 0 ? mcid : -1);
        } else if (mc.type === 'endMarkedContent') {
          mcidStack.pop();
        }
        continue;
      }

      const textItem = item as { str: string; transform: number[]; width: number; height: number };
      if (!textItem.transform) continue;

      let activeMcid = -1;
      for (let i = mcidStack.length - 1; i >= 0; i--) {
        if (mcidStack[i] >= 0) { activeMcid = mcidStack[i]; break; }
      }
      if (activeMcid < 0) continue;

      const x = textItem.transform[4];
      const y = textItem.transform[5];
      const fontSize = Math.abs(textItem.transform[0]);
      const w = textItem.width;
      const h = fontSize || textItem.height;
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

    if (mcidBBoxes.size > 0) pageMap.set(pageNum, mcidBBoxes);
  }

  return pageMap;
}

interface McidRef {
  mcid: number;
  pageNum: number | null;
}

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
    const mcidVal = kEntry.get(PDFName.of('MCID'));
    if (mcidVal instanceof PDFNumber) {
      const mcrPageRef = kEntry.get(PDFName.of('Pg'));
      let mcrPageNum: number | null = null;
      if (mcrPageRef instanceof PDFRef) {
        const pages = doc.getPages();
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].ref === mcrPageRef) { mcrPageNum = i + 1; break; }
        }
      }
      mcidRefs.push({ mcid: mcidVal.asNumber(), pageNum: mcrPageNum });
      return;
    }
    const typeVal = kEntry.get(PDFName.of('Type'));
    if (typeVal instanceof PDFName && typeVal.decodeText() === 'OBJR') return;
    if (kEntry.get(PDFName.of('S'))) return;
    const subK = kEntry.get(PDFName.of('K'));
    if (subK) collectMcids(subK, doc, mcidRefs, depth + 1);
  }
}

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

function extractExplicitBBox(node: PDFDict, doc: PDFDocument): BBox | null {
  const bboxArr = resolvePdfObj(node.get(PDFName.of('BBox')), doc);
  if (bboxArr instanceof PDFArray && bboxArr.size() >= 4) return pdfArrayToBBox(bboxArr);

  const attrRaw = node.get(PDFName.of('A'));
  if (!attrRaw) return null;

  const attr = resolvePdfObj(attrRaw, doc);
  if (attr instanceof PDFDict) return extractBBoxFromAttrDict(attr);
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
  if (bboxKey instanceof PDFArray && bboxKey.size() >= 4) return pdfArrayToBBox(bboxKey);
  const w = readNumber(dict, 'Width');
  const h = readNumber(dict, 'Height');
  if (w !== undefined && h !== undefined) return { x: 0, y: 0, w, h };
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

interface FallbackExtractionStats {
  structElements: number;
  unmappedTags: Map<string, number>;
  noPageNum: number;
  mcidsFound: number;
  mcidsWithBbox: number;
  bboxFromExplicit: number;
  droppedNoBbox: number;
}

function walkStructTree(
  node: unknown,
  doc: PDFDocument,
  zones: TaggedPdfZone[],
  mcidMap: McidBBoxMap,
  roleMap: Map<string, string>,
  stats: FallbackExtractionStats,
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
      const kids = node.get(PDFName.of('K'));
      const mcidRefs: McidRef[] = [];
      if (kids) collectMcids(kids, doc, mcidRefs, 0);
      stats.mcidsFound += mcidRefs.length;

      let bbox = bboxFromMcidRefs(mcidRefs, pageNum, mcidMap);
      if (bbox) stats.mcidsWithBbox += mcidRefs.length;

      if (!bbox) {
        bbox = extractExplicitBBox(node, doc);
        if (bbox) stats.bboxFromExplicit++;
      }

      if (bbox) {
        zones.push({ pageNumber: pageNum, bbox, zoneType, confidence: 0.9, label: resolvedTag });
      } else {
        stats.droppedNoBbox++;
        zones.push({
          pageNumber: pageNum, bbox: null, zoneType, confidence: 0,
          label: resolvedTag, isGhost: true, ghostTag: rawTag,
        });
      }
    }
  }

  const kids = node.get(PDFName.of('K'));
  if (kids) walkStructTree(kids, doc, zones, mcidMap, roleMap, stats, pageNum, depth + 1);
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract zones from a pdfxt-tagged PDF stored in S3.
 *
 * Primary path: pdfjs getStructTree() API (correct content-ID matching).
 * Fallback: pdf-lib StructTreeRoot walking (for PDFs without ParentTree).
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

  // 2. Load with pdfjs-dist
  const pdfjsDoc = await pdfjsLib.getDocument({ data: uint8Array, useSystemFonts: true }).promise;

  // 3. Try primary extraction using getStructTree() API
  const structTreeResult = await extractUsingStructTreeApi(pdfjsDoc);

  if (structTreeResult) {
    await pdfjsDoc.destroy();
    const { zones, stats } = structTreeResult;

    const totalPages = pdfjsDoc.numPages;
    const realZones = zones.filter((z) => !z.isGhost && z.bbox);
    const ghostCount = zones.filter((z) => z.isGhost).length;

    const perPage = new Map<number, number>();
    for (const z of zones) perPage.set(z.pageNumber, (perPage.get(z.pageNumber) ?? 0) + 1);

    const emptyPages: number[] = [];
    for (let p = 1; p <= totalPages; p++) {
      if (!perPage.has(p)) emptyPages.push(p);
    }

    logger.info(
      `[tagged-pdf-extractor] [structTreeApi] Extracted ${zones.length} zones (${realZones.length} real, ${ghostCount} ghost) from ${s3Path} in ${Date.now() - startTime}ms | ` +
      `struct_elements=${stats.structElements} content_ids=${stats.contentIdsFound} matched=${stats.contentIdsWithBbox} ` +
      `explicit=${stats.bboxFromExplicit} dropped=${stats.droppedNoBbox} ` +
      `opList(text:${stats.opListText} img:${stats.opListImage} path:${stats.opListPath})`,
    );

    if (stats.unmappedTags.size > 0) {
      logger.info(
        `[tagged-pdf-extractor] Unmapped tags (defaulted to paragraph): ${[...stats.unmappedTags.entries()].map(([t, c]) => `${t}(${c})`).join(', ')}`,
      );
    }

    // Per-page zone counts for first 10 pages (diagnostic)
    const perPageReal = new Map<number, number>();
    for (const z of realZones) perPageReal.set(z.pageNumber, (perPageReal.get(z.pageNumber) ?? 0) + 1);
    const samplePages = [...perPageReal.entries()].slice(0, 10).map(([p, c]) => `p${p}:${c}`).join(' ');
    logger.info(`[tagged-pdf-extractor] Per-page zones (first 10): ${samplePages}`);

    // Label distribution across all zones
    const labelCounts = new Map<string, number>();
    for (const z of realZones) labelCounts.set(z.label, (labelCounts.get(z.label) ?? 0) + 1);
    logger.info(
      `[tagged-pdf-extractor] Label distribution: ${[...labelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(', ')}`,
    );

    if (emptyPages.length > 0 && emptyPages.length < totalPages) {
      logger.warn(
        `[tagged-pdf-extractor] Pages with 0 pdfxt zones: ${emptyPages.join(', ')} (${emptyPages.length}/${totalPages})`,
      );
    }

    // Page classification
    const { classifyPages } = await import('./page-classifier');
    const pageClassifications = classifyPages(
      realZones.map((z) => ({
        pageNumber: z.pageNumber, zoneType: z.zoneType,
        label: z.label, bbox: z.bbox, isGhost: z.isGhost,
      })),
      totalPages,
    );

    return {
      jobId: calibrationRunId,
      zones,
      processingTimeMs: Date.now() - startTime,
      extractionStats: {
        structElements: stats.structElements,
        zonesExtracted: realZones.length,
        ghostZones: ghostCount,
        textMcids: stats.contentIdsWithBbox,
        imageMcids: stats.opListImage,
        opListTextMcids: stats.opListText,
        opListPathMcids: stats.opListPath,
        droppedNoBbox: stats.droppedNoBbox,
        unmappedTags: Object.fromEntries(stats.unmappedTags),
        pagesWithZeroZones: emptyPages,
        pageClassifications,
        extractionMethod: 'structTreeApi',
      },
    };
  }

  // 4. Fallback: pdf-lib StructTreeRoot walking
  logger.info(`[tagged-pdf-extractor] getStructTree() returned no results — falling back to pdf-lib extraction`);

  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const structTreeRoot = pdfDoc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structTreeRoot) {
    await pdfjsDoc.destroy();
    logger.warn(`[tagged-pdf-extractor] No StructTreeRoot found in ${s3Path}`);
    return { jobId: calibrationRunId, zones: [], processingTimeMs: Date.now() - startTime };
  }

  const mcidMap = await buildMcidBBoxMap(pdfjsDoc);
  await pdfjsDoc.destroy();

  const root = resolvePdfObj(structTreeRoot, pdfDoc);
  const roleMap = root instanceof PDFDict ? buildRoleMap(root, pdfDoc) : new Map<string, string>();

  const zones: TaggedPdfZone[] = [];
  const fallbackStats: FallbackExtractionStats = {
    structElements: 0, unmappedTags: new Map(), noPageNum: 0,
    mcidsFound: 0, mcidsWithBbox: 0, bboxFromExplicit: 0, droppedNoBbox: 0,
  };
  walkStructTree(root, pdfDoc, zones, mcidMap, roleMap, fallbackStats, null, 0);

  const totalPages = pdfDoc.getPageCount();
  const realZones = zones.filter((z) => !z.isGhost && z.bbox);
  const ghostCount = zones.filter((z) => z.isGhost).length;

  const perPage = new Map<number, number>();
  for (const z of zones) perPage.set(z.pageNumber, (perPage.get(z.pageNumber) ?? 0) + 1);
  const emptyPages: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!perPage.has(p)) emptyPages.push(p);
  }

  logger.info(
    `[tagged-pdf-extractor] [pdfLibFallback] Extracted ${zones.length} zones from ${s3Path} in ${Date.now() - startTime}ms | ` +
    `struct_elements=${fallbackStats.structElements} mcids=${fallbackStats.mcidsFound} matched=${fallbackStats.mcidsWithBbox} ` +
    `explicit=${fallbackStats.bboxFromExplicit} dropped=${fallbackStats.droppedNoBbox}`,
  );

  const { classifyPages } = await import('./page-classifier');
  const pageClassifications = classifyPages(
    realZones.map((z) => ({
      pageNumber: z.pageNumber, zoneType: z.zoneType,
      label: z.label, bbox: z.bbox, isGhost: z.isGhost,
    })),
    totalPages,
  );

  return {
    jobId: calibrationRunId,
    zones,
    processingTimeMs: Date.now() - startTime,
    extractionStats: {
      structElements: fallbackStats.structElements,
      zonesExtracted: realZones.length,
      ghostZones: ghostCount,
      textMcids: [...mcidMap.values()].reduce((sum, m) => sum + m.size, 0),
      imageMcids: 0,
      opListTextMcids: 0,
      opListPathMcids: 0,
      droppedNoBbox: fallbackStats.droppedNoBbox,
      unmappedTags: Object.fromEntries(fallbackStats.unmappedTags),
      pagesWithZeroZones: emptyPages,
      pageClassifications,
      extractionMethod: 'pdfLibFallback',
    },
  };
}
