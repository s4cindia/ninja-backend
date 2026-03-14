import { describe, it, expect } from 'vitest';
import { calculateIoU } from '../../../../src/services/calibration/iou';

describe('calculateIoU', () => {
  it('identical boxes → 1.0', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(calculateIoU(box, box)).toBe(1.0);
  });

  it('no overlap → 0.0', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 100, y: 100, w: 10, h: 10 };
    expect(calculateIoU(a, b)).toBe(0);
  });

  it('50% overlap → ~0.333', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 0, w: 10, h: 10 };
    // intersection = 5*10=50, union = 100+100-50=150, IoU=50/150≈0.333
    expect(calculateIoU(a, b)).toBeCloseTo(50 / 150, 3);
  });

  it('b inside a → 0.16', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 2, y: 2, w: 4, h: 4 };
    // intersection=16, union=100+16-16=100, IoU=16/100=0.16
    expect(calculateIoU(a, b)).toBeCloseTo(0.16, 3);
  });

  it('edge touch only → 0.0', () => {
    const a = { x: 0, y: 0, w: 5, h: 5 };
    const b = { x: 5, y: 0, w: 5, h: 5 };
    expect(calculateIoU(a, b)).toBe(0);
  });

  it('zero width box → 0.0', () => {
    const a = { x: 0, y: 0, w: 0, h: 10 };
    const b = { x: 0, y: 0, w: 10, h: 10 };
    expect(calculateIoU(a, b)).toBe(0);
  });

  it('negative coords', () => {
    const a = { x: -10, y: -10, w: 20, h: 20 };
    const b = { x: -5, y: -5, w: 20, h: 20 };
    // x1=-5,y1=-5,x2=10,y2=10, intersection=15*15=225, union=400+400-225=575
    expect(calculateIoU(a, b)).toBeCloseTo(225 / 575, 3);
  });

  it('result clamped to [0,1]', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 2, y: 2, w: 5, h: 5 };
    const result = calculateIoU(a, b);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});
