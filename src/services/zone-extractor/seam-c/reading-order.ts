import type { BBox, CanonicalZoneType } from '../types';

// Seam C — §3.1 Reading-order synthesis (the highest-risk core).
//
// A layout detector emits UNORDERED rectangles. A /StructTreeRoot needs an
// ordered /K sequence. The YOLO→Zone path leaves `readingOrder` null, so before
// any tree can be built we must synthesize a column-aware, top-to-bottom order
// over `bounds`.
//
// Coordinate convention (matches DetectedZone.bbox): PDF points, TOP-LEFT origin,
// {x, y, w, h}. So smaller `y` is higher on the page and comes first.
//
// Algorithm: recursive XY-cut (the standard for reading order).
//   1. Group zones by page; pages ascend.
//   2. Within a page, recursively cut the region: prefer a full-height VERTICAL
//      whitespace gap (→ columns; read the left region fully before the right);
//      else a full-width HORIZONTAL gap (→ rows; top before bottom); else the
//      region is atomic and is ordered top-to-bottom, then left-to-right.
//   3. A gap counts only if it exceeds max(minGapAbs, minGapFrac × extent), so
//      line/paragraph spacing doesn't trigger a cut. A full-width element (title,
//      wide table) blocks vertical gaps, forcing a horizontal cut around it.
//   4. readingOrder is assigned globally, page-major.
//
// Vertical cuts take priority so multi-column pages read column-major, while
// full-width spanners stay in place. Assumes axis-aligned content (no rotation).

export interface OrderableZone {
  pageNumber: number;
  /** PDF points, top-left origin. */
  bbox: BBox;
  zoneType: CanonicalZoneType;
}

export interface OrderedZone<T extends OrderableZone> {
  zone: T;
  /** Global 0-based reading index, page-major. */
  readingOrder: number;
}

export interface OrderConfig {
  /** a whitespace gap is a cut only if wider than this many points. */
  minGapAbs: number;
  /** …and wider than this fraction of the region's extent along that axis. */
  minGapFrac: number;
}

export const DEFAULT_ORDER_CONFIG: OrderConfig = {
  minGapAbs: 12,
  minGapFrac: 0.04,
};

const byTopThenLeft = (a: OrderableZone, b: OrderableZone): number =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x;

/**
 * Assign a column-aware, top-to-bottom reading order across all pages.
 * Returns the zones paired with a global page-major readingOrder index.
 */
export function synthesizeReadingOrder<T extends OrderableZone>(
  zones: T[],
  config: OrderConfig = DEFAULT_ORDER_CONFIG,
): OrderedZone<T>[] {
  const byPage = new Map<number, T[]>();
  for (const z of zones) {
    const list = byPage.get(z.pageNumber);
    if (list) list.push(z);
    else byPage.set(z.pageNumber, [z]);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const result: OrderedZone<T>[] = [];
  let order = 0;
  for (const page of pages) {
    for (const zone of orderPage(byPage.get(page) as T[], config)) {
      result.push({ zone, readingOrder: order++ });
    }
  }
  return result;
}

function orderPage<T extends OrderableZone>(zones: T[], config: OrderConfig): T[] {
  return xyCut(zones, config);
}

interface Gap { pos: number; size: number; }

/** Widest gap between the (projected) intervals; null if they fully overlap. */
function widestGap(intervals: Array<[number, number]>): Gap | null {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let maxEnd = sorted[0][1];
  let best = 0;
  let pos: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] > maxEnd) {
      const size = sorted[i][0] - maxEnd;
      if (size > best) { best = size; pos = maxEnd + size / 2; }
    }
    maxEnd = Math.max(maxEnd, sorted[i][1]);
  }
  return pos === null ? null : { pos, size: best };
}

/**
 * Recursive XY-cut. A vertical whitespace gap (columns) is cut first so reading is
 * column-major; a full-width element blocks vertical gaps and forces a horizontal
 * cut (rows) around it. With no significant gap the region is atomic.
 */
function xyCut<T extends OrderableZone>(zones: T[], config: OrderConfig): T[] {
  if (zones.length <= 1) return zones;

  const xs = zones.map((z) => [z.bbox.x, z.bbox.x + z.bbox.w] as [number, number]);
  const ys = zones.map((z) => [z.bbox.y, z.bbox.y + z.bbox.h] as [number, number]);
  const extentX = Math.max(...xs.map((i) => i[1])) - Math.min(...xs.map((i) => i[0]));
  const extentY = Math.max(...ys.map((i) => i[1])) - Math.min(...ys.map((i) => i[0]));

  const vGap = widestGap(xs);
  if (vGap && vGap.size >= Math.max(config.minGapAbs, config.minGapFrac * extentX)) {
    const left: T[] = [];
    const right: T[] = [];
    for (const z of zones) (z.bbox.x + z.bbox.w / 2 < vGap.pos ? left : right).push(z);
    if (left.length && right.length) return [...xyCut(left, config), ...xyCut(right, config)];
  }

  const hGap = widestGap(ys);
  if (hGap && hGap.size >= Math.max(config.minGapAbs, config.minGapFrac * extentY)) {
    const top: T[] = [];
    const bottom: T[] = [];
    for (const z of zones) (z.bbox.y + z.bbox.h / 2 < hGap.pos ? top : bottom).push(z);
    if (top.length && bottom.length) return [...xyCut(top, config), ...xyCut(bottom, config)];
  }

  // No usable cut → atomic region, ordered top-to-bottom then left-to-right.
  return [...zones].sort(byTopThenLeft);
}
