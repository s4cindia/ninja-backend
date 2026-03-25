import { calculateIoU, type BBox } from './iou';
import type { CanonicalZoneType } from '../zone-extractor/types';

export interface SourceZone {
  pageNumber: number;
  bbox: BBox;
  zoneType: CanonicalZoneType;
  confidence: number | null;
  label: string;
}

export interface ZoneMatch {
  doclingZone: SourceZone | null;
  pdfxtZone: SourceZone | null;
  iou: number;
  reconciliationBucket: 'GREEN' | 'AMBER' | 'RED';
  typeDisagreement?: { doclingLabel: string; pdfxtLabel: string };
}

const IOU_THRESHOLD = 0.5;

/**
 * Greedy zone matching between Docling and pdfxt detection results.
 * Matching is done PER-PAGE to prevent cross-page false matches
 * (zones on different pages often share similar bbox coordinates).
 *
 * Bucket decision tree:
 *   GREEN: IoU >= 0.5 AND same zoneType
 *   AMBER: IoU >= 0.5 AND different zoneTypes
 *   RED:   IoU < 0.5 OR no matching zone from the other tool
 */
export function matchZones(
  doclingZones: SourceZone[],
  pdfxtZones: SourceZone[],
  iouThreshold = IOU_THRESHOLD,
): ZoneMatch[] {
  // Group zones by page for page-scoped matching
  const doclingByPage = new Map<number, SourceZone[]>();
  const pdfxtByPage = new Map<number, { zone: SourceZone; idx: number }[]>();

  doclingZones.forEach((z) => {
    const arr = doclingByPage.get(z.pageNumber) ?? [];
    arr.push(z);
    doclingByPage.set(z.pageNumber, arr);
  });

  pdfxtZones.forEach((z, idx) => {
    const arr = pdfxtByPage.get(z.pageNumber) ?? [];
    arr.push({ zone: z, idx });
    pdfxtByPage.set(z.pageNumber, arr);
  });

  // Collect all page numbers from both sources
  const allPages = new Set([...doclingByPage.keys(), ...pdfxtByPage.keys()]);

  const matchedPdfxtIndices = new Set<number>();
  const matches: ZoneMatch[] = [];

  for (const page of allPages) {
    const pageDocling = doclingByPage.get(page) ?? [];
    const pagePdfxt = pdfxtByPage.get(page) ?? [];

    for (const doclingZone of pageDocling) {
      let bestIoU = 0;
      let bestEntry: { zone: SourceZone; idx: number } | null = null;

      for (const entry of pagePdfxt) {
        if (matchedPdfxtIndices.has(entry.idx)) continue;
        const iou = calculateIoU(doclingZone.bbox, entry.zone.bbox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestEntry = entry;
        }
      }

      if (bestIoU >= iouThreshold && bestEntry) {
        matchedPdfxtIndices.add(bestEntry.idx);
        const pdfxtZone = bestEntry.zone;
        const sameType = doclingZone.zoneType === pdfxtZone.zoneType;
        matches.push({
          doclingZone,
          pdfxtZone,
          iou: bestIoU,
          reconciliationBucket: sameType ? 'GREEN' : 'AMBER',
          typeDisagreement: sameType
            ? undefined
            : {
                doclingLabel: doclingZone.label,
                pdfxtLabel: pdfxtZone.label,
              },
        });
      } else {
        matches.push({
          doclingZone,
          pdfxtZone: null,
          iou: bestIoU,
          reconciliationBucket: 'RED',
        });
      }
    }

    // Unmatched pdfxt zones on this page
    for (const entry of pagePdfxt) {
      if (matchedPdfxtIndices.has(entry.idx)) continue;
      matches.push({
        doclingZone: null,
        pdfxtZone: entry.zone,
        iou: 0,
        reconciliationBucket: 'RED',
      });
    }
  }

  return matches;
}
