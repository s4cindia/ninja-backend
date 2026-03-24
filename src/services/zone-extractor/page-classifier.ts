import type { CanonicalZoneType } from './types';

export type PageType = 'title' | 'toc' | 'body' | 'index' | 'blank' | 'unknown';

interface ZoneInfo {
  pageNumber: number;
  zoneType: CanonicalZoneType;
  label: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  isGhost?: boolean;
}

interface PageClassification {
  pageNumber: number;
  pageType: PageType;
  zoneCount: number;
  confidence: number; // 0-1, how confident the heuristic is
}

/**
 * Classify pages based on zone composition heuristics.
 *
 * Heuristics:
 * - title: few zones (1-5), large headings, figure(s), no body paragraphs
 * - toc: TOC/TOCI tags or many list items, heading "table of contents"
 * - body: mix of headings + paragraphs + possibly tables/figures
 * - index: very high zone count, mostly paragraph/list items
 * - blank: 0 zones
 */
export function classifyPages(
  zones: ZoneInfo[],
  totalPages: number,
): PageClassification[] {
  const perPage = new Map<number, ZoneInfo[]>();
  for (const z of zones) {
    const list = perPage.get(z.pageNumber) ?? [];
    list.push(z);
    perPage.set(z.pageNumber, list);
  }

  const results: PageClassification[] = [];

  for (let p = 1; p <= totalPages; p++) {
    const pageZones = perPage.get(p) ?? [];
    const nonGhost = pageZones.filter((z) => !z.isGhost);

    if (nonGhost.length === 0) {
      results.push({ pageNumber: p, pageType: 'blank', zoneCount: 0, confidence: 0.8 });
      continue;
    }

    const typeCounts = new Map<string, number>();
    for (const z of nonGhost) {
      typeCounts.set(z.zoneType, (typeCounts.get(z.zoneType) ?? 0) + 1);
    }

    const headings = typeCounts.get('section-header') ?? 0;
    const paragraphs = typeCounts.get('paragraph') ?? 0;
    const figures = typeCounts.get('figure') ?? 0;
    const tables = typeCounts.get('table') ?? 0;
    const total = nonGhost.length;

    // Check labels for TOC indicators
    const hasTocLabel = nonGhost.some((z) =>
      /^(toc|table\s*of\s*contents)/i.test(z.label),
    );

    // Title page: few zones, prominent heading, possibly figure, minimal body text
    if (total <= 5 && headings >= 1 && paragraphs <= 2) {
      // First few pages are more likely title pages
      const pageBonus = p <= 3 ? 0.2 : 0;
      const figBonus = figures >= 1 ? 0.1 : 0;
      results.push({
        pageNumber: p,
        pageType: 'title',
        zoneCount: total,
        confidence: Math.min(0.7 + pageBonus + figBonus, 1.0),
      });
      continue;
    }

    // TOC page: TOC labels or many list-like items on early pages
    if (hasTocLabel || (total > 10 && paragraphs > 8 && headings <= 1 && p <= 10)) {
      results.push({
        pageNumber: p,
        pageType: 'toc',
        zoneCount: total,
        confidence: hasTocLabel ? 0.9 : 0.5,
      });
      continue;
    }

    // Index page: very high zone count, mostly paragraphs, typically late in document
    if (total > 30 && paragraphs / total > 0.8 && p > totalPages * 0.8) {
      results.push({
        pageNumber: p,
        pageType: 'index',
        zoneCount: total,
        confidence: 0.5,
      });
      continue;
    }

    // Default: body page
    results.push({
      pageNumber: p,
      pageType: 'body',
      zoneCount: total,
      confidence: 0.8,
    });
  }

  return results;
}
