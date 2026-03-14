import { describe, it, expect } from 'vitest';
import { calculateMAP } from '../../../../src/services/metrics/map.service';
import type {
  AnnotatedZone,
  PredictedZone,
} from '../../../../src/services/metrics/ml-metrics.types';
import type { CanonicalZoneType } from '../../../../src/services/zone-extractor/types';

const ALL_TYPES: CanonicalZoneType[] = [
  'paragraph', 'section-header', 'table', 'figure',
  'caption', 'footnote', 'header', 'footer',
];

function makeGT(zoneType: CanonicalZoneType, idx: number): AnnotatedZone {
  return {
    pageNumber: 1,
    bbox: { x: idx * 20, y: 0, w: 10, h: 10 },
    zoneType,
  };
}

function makePred(zoneType: CanonicalZoneType, idx: number, confidence = 0.9): PredictedZone {
  return {
    pageNumber: 1,
    bbox: { x: idx * 20, y: 0, w: 10, h: 10 },
    zoneType,
    confidence,
  };
}

describe('calculateMAP', () => {
  it('all types with sufficient data → overallMAP close to 1.0', () => {
    const gt: AnnotatedZone[] = [];
    const pred: PredictedZone[] = [];

    for (const type of ALL_TYPES) {
      for (let i = 0; i < 5; i++) {
        gt.push(makeGT(type, i + ALL_TYPES.indexOf(type) * 10));
        pred.push(makePred(type, i + ALL_TYPES.indexOf(type) * 10));
      }
    }

    const result = calculateMAP(gt, pred);
    expect(result.overallMAP).toBeCloseTo(1.0, 1);
    expect(result.insufficientDataWarnings).toHaveLength(0);
    expect(result.perClass).toHaveLength(8);
    expect(result.perClass.every((c) => !c.insufficientData)).toBe(true);
  });

  it('insufficient data warning for footnote', () => {
    const gt: AnnotatedZone[] = [];
    const pred: PredictedZone[] = [];

    for (const type of ALL_TYPES) {
      const count = type === 'footnote' ? 3 : 5;
      for (let i = 0; i < count; i++) {
        gt.push(makeGT(type, i + ALL_TYPES.indexOf(type) * 10));
        pred.push(makePred(type, i + ALL_TYPES.indexOf(type) * 10));
      }
    }

    const result = calculateMAP(gt, pred);
    const footnoteClass = result.perClass.find((c) => c.zoneType === 'footnote')!;
    expect(footnoteClass.insufficientData).toBe(true);
    expect(footnoteClass.ap).toBe(0);
    expect(
      result.insufficientDataWarnings.some((w) => w.includes('footnote')),
    ).toBe(true);
    // overallMAP should exclude footnote — still close to 1.0
    expect(result.overallMAP).toBeGreaterThan(0.9);
  });

  it('all types insufficient → overallMAP = 0', () => {
    const gt: AnnotatedZone[] = [];
    const pred: PredictedZone[] = [];

    for (const type of ALL_TYPES) {
      for (let i = 0; i < 2; i++) {
        gt.push(makeGT(type, i));
        pred.push(makePred(type, i));
      }
    }

    const result = calculateMAP(gt, pred);
    expect(result.overallMAP).toBe(0);
    expect(result.perClass.every((c) => c.insufficientData)).toBe(true);
    expect(result.insufficientDataWarnings).toHaveLength(8);
  });

  it('zero ground truth → overallMAP = 0', () => {
    const result = calculateMAP([], []);
    expect(result.overallMAP).toBe(0);
    expect(result.perClass.every((c) => c.insufficientData)).toBe(true);
  });

  it('determinism: same inputs → identical results', () => {
    const gt = ALL_TYPES.flatMap((type) =>
      Array.from({ length: 5 }, (_, i) => makeGT(type, i + ALL_TYPES.indexOf(type) * 10)),
    );
    const pred = ALL_TYPES.flatMap((type) =>
      Array.from({ length: 5 }, (_, i) => makePred(type, i + ALL_TYPES.indexOf(type) * 10)),
    );

    const r1 = calculateMAP(gt, pred);
    const r2 = calculateMAP(gt, pred);
    expect(r1).toEqual(r2);
  });

  it('overallMAP rounded to 4 decimal places', () => {
    // Use mismatched counts to produce a non-round number
    const gt: AnnotatedZone[] = [];
    const pred: PredictedZone[] = [];

    // Only paragraph with 7 GT, 5 matching preds + 2 wrong type
    for (let i = 0; i < 7; i++) {
      gt.push(makeGT('paragraph', i));
    }
    for (let i = 0; i < 5; i++) {
      pred.push(makePred('paragraph', i, 0.9 - i * 0.1));
    }
    pred.push(makePred('paragraph', 100, 0.3)); // no matching GT
    pred.push(makePred('paragraph', 101, 0.2)); // no matching GT

    const result = calculateMAP(gt, pred);
    const str = result.overallMAP.toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });
});
