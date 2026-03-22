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
  const matchedPdfxtIndices = new Set<number>();
  const matches: ZoneMatch[] = [];

  for (const doclingZone of doclingZones) {
    let bestIoU = 0;
    let bestPdfxtIdx = -1;

    pdfxtZones.forEach((pdfxtZone, pi) => {
      if (matchedPdfxtIndices.has(pi)) return;
      const iou = calculateIoU(doclingZone.bbox, pdfxtZone.bbox);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestPdfxtIdx = pi;
      }
    });

    if (bestIoU >= iouThreshold && bestPdfxtIdx !== -1) {
      matchedPdfxtIndices.add(bestPdfxtIdx);
      const pdfxtZone = pdfxtZones[bestPdfxtIdx];
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

  pdfxtZones.forEach((pdfxtZone, pi) => {
    if (matchedPdfxtIndices.has(pi)) return;
    matches.push({
      doclingZone: null,
      pdfxtZone,
      iou: 0,
      reconciliationBucket: 'RED',
    });
  });

  return matches;
}
