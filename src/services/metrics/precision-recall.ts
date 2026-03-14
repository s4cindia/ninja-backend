import { calculateIoU } from '../calibration/iou';
import type { AnnotatedZone, PredictedZone, PRCurve } from './ml-metrics.types';

export const IOU_THRESHOLD = 0.5;
export const MIN_INSTANCES = 5;

export function calculatePrecisionRecall(
  groundTruth: AnnotatedZone[],
  predictions: PredictedZone[],
  iouThreshold = IOU_THRESHOLD,
): PRCurve {
  if (groundTruth.length === 0) {
    return { points: [], ap: 0 };
  }

  // Sort predictions by confidence descending
  const sorted = [...predictions].sort(
    (a, b) => b.confidence - a.confidence,
  );

  const matchedGT = new Set<number>();
  let tp = 0;
  let fp = 0;
  const tpCumulative: number[] = [];
  const fpCumulative: number[] = [];

  for (const pred of sorted) {
    let bestIoU = 0;
    let bestGTIdx = -1;

    for (let gi = 0; gi < groundTruth.length; gi++) {
      if (matchedGT.has(gi)) continue;
      const gt = groundTruth[gi];
      if (gt.pageNumber !== pred.pageNumber) continue;
      if (gt.zoneType !== pred.zoneType) continue;

      const iou = calculateIoU(gt.bbox, pred.bbox);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestGTIdx = gi;
      }
    }

    if (bestIoU >= iouThreshold && bestGTIdx !== -1) {
      matchedGT.add(bestGTIdx);
      tp++;
    } else {
      fp++;
    }

    tpCumulative.push(tp);
    fpCumulative.push(fp);
  }

  const total = groundTruth.length;
  const points = tpCumulative.map((tpVal, i) => ({
    precision: tpVal / (tpVal + fpCumulative[i]),
    recall: tpVal / total,
  }));

  // Compute AP via trapezoidal integration
  // Prepend origin (recall=0, precision=first point's precision)
  // to capture area from recall=0 to the first recall value.
  let ap: number;
  if (points.length === 0) {
    ap = 0;
  } else {
    const sortedPoints = [...points].sort((a, b) => a.recall - b.recall);
    // Add origin point to capture the full area under the curve
    const withOrigin = [
      { precision: sortedPoints[0].precision, recall: 0 },
      ...sortedPoints,
    ];
    ap = 0;
    for (let i = 1; i < withOrigin.length; i++) {
      const deltaRecall = withOrigin[i].recall - withOrigin[i - 1].recall;
      const avgPrecision =
        (withOrigin[i].precision + withOrigin[i - 1].precision) / 2;
      ap += deltaRecall * avgPrecision;
    }
  }

  return { points, ap: Math.min(1, Math.max(0, ap)) };
}
