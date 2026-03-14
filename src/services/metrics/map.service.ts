import {
  calculatePrecisionRecall,
  MIN_INSTANCES,
} from './precision-recall';
import type {
  AnnotatedZone,
  PredictedZone,
  MAPResult,
  ClassAPResult,
} from './ml-metrics.types';
import type { CanonicalZoneType } from '../zone-extractor/types';

const ALL_ZONE_TYPES: CanonicalZoneType[] = [
  'paragraph',
  'section-header',
  'table',
  'figure',
  'caption',
  'footnote',
  'header',
  'footer',
];

export function calculateMAP(
  groundTruth: AnnotatedZone[],
  predictions: PredictedZone[],
): MAPResult {
  // Group by zoneType
  const gtByType = new Map<CanonicalZoneType, AnnotatedZone[]>();
  for (const gt of groundTruth) {
    const arr = gtByType.get(gt.zoneType) ?? [];
    arr.push(gt);
    gtByType.set(gt.zoneType, arr);
  }

  const predByType = new Map<CanonicalZoneType, PredictedZone[]>();
  for (const pred of predictions) {
    const arr = predByType.get(pred.zoneType) ?? [];
    arr.push(pred);
    predByType.set(pred.zoneType, arr);
  }

  const perClass: ClassAPResult[] = [];
  const insufficientDataWarnings: string[] = [];

  for (const zoneType of ALL_ZONE_TYPES) {
    const gtForType = gtByType.get(zoneType) ?? [];
    const predForType = predByType.get(zoneType) ?? [];
    const insufficientData = gtForType.length < MIN_INSTANCES;

    let ap: number;
    if (insufficientData) {
      ap = 0;
      if (gtForType.length > 0 || predForType.length > 0) {
        insufficientDataWarnings.push(
          `${zoneType}: only ${gtForType.length} ground truth instances (minimum ${MIN_INSTANCES} required)`,
        );
      }
    } else {
      const curve = calculatePrecisionRecall(gtForType, predForType);
      ap = curve.ap;
    }

    perClass.push({
      zoneType,
      ap,
      groundTruthCount: gtForType.length,
      predictionCount: predForType.length,
      insufficientData,
    });
  }

  const validClasses = perClass.filter((c) => !c.insufficientData);
  let overallMAP: number;
  if (validClasses.length === 0) {
    overallMAP = 0;
  } else {
    overallMAP =
      validClasses.reduce((sum, c) => sum + c.ap, 0) / validClasses.length;
  }
  overallMAP = Math.round(overallMAP * 10000) / 10000;

  return {
    overallMAP,
    perClass,
    insufficientDataWarnings,
    groundTruthTotal: groundTruth.length,
    predictionTotal: predictions.length,
  };
}
