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
// Algorithm (band + column, an XY-cut approximation robust to the common cases):
//   1. Group zones by page; pages ascend.
//   2. Within a page, walk zones top-to-bottom. A "full-width" zone (title, wide
//      table/figure spanning the text block) acts as a BAND SEPARATOR: it flushes
//      the accumulated column zones above it, emits in place, and starts a new band.
//   3. Each band's column zones are clustered by horizontal (x-interval) overlap,
//      columns ordered left-to-right, and each column ordered top-to-bottom.
//   4. readingOrder is assigned globally, page-major.
//
// This is a Phase-1 prototype: correct on 1-col, n-col, and full-width-spanner
// layouts (the shapes the Phase-0 spike checks). It does NOT yet handle wrapped
// text flow around floats or rotated pages — Phase 2 refines against real MCIDs.

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
  /** width ≥ fullWidthFrac × pageWidth ⇒ full-width band separator. */
  fullWidthFrac: number;
  /** min x-interval overlap (points) to group two zones into one column. */
  columnOverlapTol: number;
}

export const DEFAULT_ORDER_CONFIG: OrderConfig = {
  fullWidthFrac: 0.65,
  columnOverlapTol: 12,
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
  if (zones.length <= 1) return zones;

  const pageLeft = Math.min(...zones.map((z) => z.bbox.x));
  const pageRight = Math.max(...zones.map((z) => z.bbox.x + z.bbox.w));
  const pageWidth = pageRight - pageLeft || 1;
  const isFullWidth = (z: T): boolean => z.bbox.w >= config.fullWidthFrac * pageWidth;

  const sorted = [...zones].sort(byTopThenLeft);
  const out: T[] = [];
  let band: T[] = [];
  const flush = (): void => {
    if (band.length) {
      out.push(...orderColumns(band, config));
      band = [];
    }
  };

  for (const z of sorted) {
    if (isFullWidth(z)) {
      flush();
      out.push(z);
    } else {
      band.push(z);
    }
  }
  flush();
  return out;
}

interface Column<T> {
  minX: number;
  maxX: number;
  zones: T[];
}

function orderColumns<T extends OrderableZone>(zones: T[], config: OrderConfig): T[] {
  if (zones.length <= 1) return zones;
  const columns = clusterColumns(zones, config.columnOverlapTol);
  columns.sort((a, b) => a.minX - b.minX);
  return columns.flatMap((c) => c.zones.sort(byTopThenLeft));
}

/**
 * Greedy x-interval clustering: each zone joins the existing column it overlaps
 * most (beyond `tol`), else opens a new column. Vertically-stacked zones share an
 * x-range and cluster together; side-by-side columns don't overlap and separate.
 */
function clusterColumns<T extends OrderableZone>(zones: T[], tol: number): Column<T>[] {
  const sorted = [...zones].sort((a, b) => a.bbox.x - b.bbox.x);
  const columns: Column<T>[] = [];
  for (const z of sorted) {
    const zL = z.bbox.x;
    const zR = z.bbox.x + z.bbox.w;
    let best: Column<T> | null = null;
    let bestOverlap = tol;
    for (const c of columns) {
      const overlap = Math.min(zR, c.maxX) - Math.max(zL, c.minX);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = c;
      }
    }
    if (best) {
      best.minX = Math.min(best.minX, zL);
      best.maxX = Math.max(best.maxX, zR);
      best.zones.push(z);
    } else {
      columns.push({ minX: zL, maxX: zR, zones: [z] });
    }
  }
  return columns;
}
