import type { BBox } from '../calibration/iou';
import type { CanonicalZoneType } from '../zone-extractor/types';

export interface AnnotatedZone {
  pageNumber: number;
  bbox: BBox;
  zoneType: CanonicalZoneType;
}

export interface PredictedZone {
  pageNumber: number;
  bbox: BBox;
  zoneType: CanonicalZoneType;
  confidence: number;
}

export interface ClassAPResult {
  zoneType: CanonicalZoneType;
  ap: number;
  groundTruthCount: number;
  predictionCount: number;
  insufficientData: boolean;
}

export interface MAPResult {
  overallMAP: number;
  perClass: ClassAPResult[];
  insufficientDataWarnings: string[];
  groundTruthTotal: number;
  predictionTotal: number;
}

export interface PRPoint {
  precision: number;
  recall: number;
}

export interface PRCurve {
  points: PRPoint[];
  ap: number;
}
