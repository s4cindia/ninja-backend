import { describe, it, expect } from 'vitest';
import { summariseCalibrationRun } from '../../../../src/services/calibration/calibration-summary';
import type { ZoneMatch } from '../../../../src/services/calibration/zone-matcher';

function makeMatch(
  bucket: 'GREEN' | 'AMBER' | 'RED',
  docLabel?: string,
  pdfxtLabel?: string,
): ZoneMatch {
  const base: ZoneMatch = {
    doclingZone: {
      pageNumber: 1,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      zoneType: 'paragraph',
      confidence: 0.9,
      label: docLabel ?? 'Text',
    },
    pdfxtZone: {
      pageNumber: 1,
      bbox: { x: 1, y: 0, w: 10, h: 10 },
      zoneType: 'paragraph',
      confidence: 0.9,
      label: pdfxtLabel ?? 'text',
    },
    iou: 0.8,
    reconciliationBucket: bucket,
  };

  if (bucket === 'AMBER' && docLabel && pdfxtLabel) {
    base.typeDisagreement = { doclingLabel: docLabel, pdfxtLabel };
  }

  return base;
}

describe('summariseCalibrationRun', () => {
  it('empty input → all zeros', () => {
    const result = summariseCalibrationRun([]);
    expect(result.greenCount).toBe(0);
    expect(result.amberCount).toBe(0);
    expect(result.redCount).toBe(0);
    expect(result.totalZones).toBe(0);
    expect(result.amberBreakdown).toEqual({});
  });

  it('5 GREEN → 100%', () => {
    const matches = Array.from({ length: 5 }, () => makeMatch('GREEN'));
    const result = summariseCalibrationRun(matches);
    expect(result.greenCount).toBe(5);
    expect(result.greenPct).toBe(100.0);
    expect(result.amberCount).toBe(0);
    expect(result.redCount).toBe(0);
  });

  it('6G/3A/1R → correct percentages', () => {
    const matches = [
      ...Array.from({ length: 6 }, () => makeMatch('GREEN')),
      ...Array.from({ length: 3 }, () => makeMatch('AMBER', 'Text', 'heading')),
      makeMatch('RED'),
    ];
    const result = summariseCalibrationRun(matches);
    expect(result.greenPct).toBe(60.0);
    expect(result.amberPct).toBe(30.0);
    expect(result.redPct).toBe(10.0);
  });

  it('amberBreakdown groups by label pair', () => {
    const matches = [
      makeMatch('AMBER', 'Section-Header', 'Text'),
      makeMatch('AMBER', 'Section-Header', 'Text'),
      makeMatch('AMBER', 'Table', 'Picture'),
    ];
    const result = summariseCalibrationRun(matches);
    expect(result.amberBreakdown).toEqual({
      'Section-Header→Text': 2,
      'Table→Picture': 1,
    });
  });

  it('AMBER with no typeDisagreement → no crash', () => {
    const match = makeMatch('AMBER');
    // explicitly remove typeDisagreement
    delete match.typeDisagreement;
    const result = summariseCalibrationRun([match]);
    expect(result.amberCount).toBe(1);
    expect(result.amberBreakdown).toEqual({});
  });

  it('rounding: 1G of 3 → 33.3', () => {
    const matches = [makeMatch('GREEN'), makeMatch('AMBER', 'A', 'B'), makeMatch('RED')];
    const result = summariseCalibrationRun(matches);
    expect(result.greenPct).toBe(33.3);
  });
});
