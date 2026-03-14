import { describe, it, expect } from 'vitest';
import { calculatePrecisionRecall } from '../../../../src/services/metrics/precision-recall';
import type {
  AnnotatedZone,
  PredictedZone,
} from '../../../../src/services/metrics/ml-metrics.types';

function makeGT(
  zoneType: AnnotatedZone['zoneType'] = 'paragraph',
  bbox = { x: 0, y: 0, w: 10, h: 10 },
  pageNumber = 1,
): AnnotatedZone {
  return { pageNumber, bbox, zoneType };
}

function makePred(
  zoneType: PredictedZone['zoneType'] = 'paragraph',
  bbox = { x: 0, y: 0, w: 10, h: 10 },
  confidence = 0.9,
  pageNumber = 1,
): PredictedZone {
  return { pageNumber, bbox, zoneType, confidence };
}

describe('calculatePrecisionRecall', () => {
  it('perfect detection → ap = 1.0', () => {
    const gt = [makeGT()];
    const pred = [makePred()];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBe(1.0);
    expect(result.points).toHaveLength(1);
    expect(result.points[0].precision).toBe(1);
    expect(result.points[0].recall).toBe(1);
  });

  it('zero precision: wrong type → ap = 0', () => {
    const gt = [makeGT('paragraph')];
    const pred = [makePred('table')];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBe(0);
  });

  it('50% recall: 2 GT, 1 matching prediction', () => {
    const gt = [
      makeGT('paragraph', { x: 0, y: 0, w: 10, h: 10 }),
      makeGT('paragraph', { x: 20, y: 0, w: 10, h: 10 }),
    ];
    const pred = [makePred('paragraph', { x: 0, y: 0, w: 10, h: 10 }, 0.9)];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBeGreaterThan(0);
    expect(result.ap).toBeLessThan(1);
    // Max recall is 0.5
    const maxRecall = Math.max(...result.points.map((p) => p.recall));
    expect(maxRecall).toBe(0.5);
  });

  it('confidence ordering: both match → ap = 1.0', () => {
    const gt = [
      makeGT('paragraph', { x: 0, y: 0, w: 10, h: 10 }),
      makeGT('paragraph', { x: 20, y: 0, w: 10, h: 10 }),
    ];
    const pred = [
      makePred('paragraph', { x: 0, y: 0, w: 10, h: 10 }, 0.6),
      makePred('paragraph', { x: 20, y: 0, w: 10, h: 10 }, 0.9),
    ];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBe(1.0);
  });

  it('no ground truth → ap = 0, empty points', () => {
    const pred = [makePred()];
    const result = calculatePrecisionRecall([], pred);
    expect(result.ap).toBe(0);
    expect(result.points).toEqual([]);
  });

  it('no predictions → ap = 0', () => {
    const gt = [makeGT(), makeGT('paragraph', { x: 20, y: 0, w: 10, h: 10 })];
    const result = calculatePrecisionRecall(gt, []);
    expect(result.ap).toBe(0);
  });

  it('page number isolation: different pages → no match', () => {
    const gt = [makeGT('paragraph', { x: 0, y: 0, w: 10, h: 10 }, 1)];
    const pred = [makePred('paragraph', { x: 0, y: 0, w: 10, h: 10 }, 0.9, 2)];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBe(0);
  });

  it('AP clamped to [0, 1]', () => {
    const gt = [makeGT()];
    const pred = [makePred()];
    const result = calculatePrecisionRecall(gt, pred);
    expect(result.ap).toBeGreaterThanOrEqual(0);
    expect(result.ap).toBeLessThanOrEqual(1);
  });
});
