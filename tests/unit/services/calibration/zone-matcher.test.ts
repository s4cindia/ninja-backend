import { describe, it, expect } from 'vitest';
import {
  matchZones,
  type SourceZone,
} from '../../../../src/services/calibration/zone-matcher';

function makeZone(overrides: Partial<SourceZone> = {}): SourceZone {
  return {
    pageNumber: 1,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    zoneType: 'paragraph',
    confidence: 0.9,
    label: 'Text',
    ...overrides,
  };
}

describe('matchZones', () => {
  it('both empty → []', () => {
    expect(matchZones([], [])).toEqual([]);
  });

  it('all GREEN: 2 pairs, same type, high IoU', () => {
    const d = [
      makeZone({ bbox: { x: 0, y: 0, w: 10, h: 10 } }),
      makeZone({ bbox: { x: 20, y: 0, w: 10, h: 10 } }),
    ];
    const p = [
      makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 } }),
      makeZone({ bbox: { x: 21, y: 0, w: 10, h: 10 } }),
    ];
    const result = matchZones(d, p);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.reconciliationBucket === 'GREEN')).toBe(true);
  });

  it('all AMBER: 2 pairs, different types', () => {
    const d = [
      makeZone({ bbox: { x: 0, y: 0, w: 10, h: 10 }, zoneType: 'paragraph', label: 'Text' }),
      makeZone({ bbox: { x: 20, y: 0, w: 10, h: 10 }, zoneType: 'table', label: 'Table' }),
    ];
    const p = [
      makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 }, zoneType: 'section-header', label: 'heading' }),
      makeZone({ bbox: { x: 21, y: 0, w: 10, h: 10 }, zoneType: 'figure', label: 'figure' }),
    ];
    const result = matchZones(d, p);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.reconciliationBucket === 'AMBER')).toBe(true);
    expect(result.every((m) => m.typeDisagreement !== undefined)).toBe(true);
  });

  it('unmatched docling → all RED, pdfxtZone null', () => {
    const d = [makeZone(), makeZone({ bbox: { x: 20, y: 0, w: 10, h: 10 } })];
    const result = matchZones(d, []);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.reconciliationBucket === 'RED')).toBe(true);
    expect(result.every((m) => m.pdfxtZone === null)).toBe(true);
  });

  it('unmatched pdfxt → all RED, doclingZone null', () => {
    const p = [makeZone(), makeZone({ bbox: { x: 20, y: 0, w: 10, h: 10 } })];
    const result = matchZones([], p);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.reconciliationBucket === 'RED')).toBe(true);
    expect(result.every((m) => m.doclingZone === null)).toBe(true);
  });

  it('mixed: 1 GREEN, 1 AMBER, 1 RED', () => {
    const d = [
      makeZone({ bbox: { x: 0, y: 0, w: 10, h: 10 }, zoneType: 'paragraph', label: 'Text' }),
      makeZone({ bbox: { x: 20, y: 0, w: 10, h: 10 }, zoneType: 'table', label: 'Table' }),
      makeZone({ bbox: { x: 100, y: 100, w: 10, h: 10 }, zoneType: 'figure', label: 'Picture' }),
    ];
    const p = [
      makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 }, zoneType: 'paragraph', label: 'text' }),
      makeZone({ bbox: { x: 21, y: 0, w: 10, h: 10 }, zoneType: 'figure', label: 'figure' }),
      makeZone({ bbox: { x: 200, y: 200, w: 10, h: 10 }, zoneType: 'paragraph', label: 'text' }),
    ];
    const result = matchZones(d, p);
    const green = result.filter((m) => m.reconciliationBucket === 'GREEN');
    const amber = result.filter((m) => m.reconciliationBucket === 'AMBER');
    const red = result.filter((m) => m.reconciliationBucket === 'RED');
    expect(green).toHaveLength(1);
    expect(amber).toHaveLength(1);
    expect(red).toHaveLength(2); // d[2] unmatched + p[2] unmatched
  });

  it('AMBER special: table vs figure', () => {
    const d = [makeZone({ zoneType: 'table', label: 'Table' })];
    const p = [makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 }, zoneType: 'figure', label: 'figure' })];
    const result = matchZones(d, p);
    expect(result[0].reconciliationBucket).toBe('AMBER');
  });

  it('greedy: no double-matching', () => {
    // d[0] has IoU 0.7 with p[0] and IoU 0.6 with p[1]
    // d[1] has IoU 0.9 with p[0]
    // Greedy processes d[0] first → matches p[0]
    // d[1] can only match p[1]
    const d = [
      makeZone({ bbox: { x: 0, y: 0, w: 10, h: 10 } }),
      makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 } }),
    ];
    const p = [
      makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 } }),
      makeZone({ bbox: { x: 3, y: 0, w: 10, h: 10 } }),
    ];
    const result = matchZones(d, p);
    // p[0] should only appear once
    const matchedPdfxt = result
      .filter((m) => m.pdfxtZone !== null)
      .map((m) => m.pdfxtZone);
    const pdfxtIds = new Set(matchedPdfxt.map((z) => JSON.stringify(z!.bbox)));
    expect(pdfxtIds.size).toBe(matchedPdfxt.length);
  });

  it('typeDisagreement undefined on GREEN', () => {
    const d = [makeZone()];
    const p = [makeZone({ bbox: { x: 1, y: 0, w: 10, h: 10 } })];
    const result = matchZones(d, p);
    expect(result[0].reconciliationBucket).toBe('GREEN');
    expect(result[0].typeDisagreement).toBeUndefined();
  });

  it('typeDisagreement labels correct on AMBER', () => {
    const d = [makeZone({ zoneType: 'paragraph', label: 'Text' })];
    const p = [
      makeZone({
        bbox: { x: 1, y: 0, w: 10, h: 10 },
        zoneType: 'section-header',
        label: 'heading',
      }),
    ];
    const result = matchZones(d, p);
    expect(result[0].reconciliationBucket).toBe('AMBER');
    expect(result[0].typeDisagreement).toEqual({
      doclingLabel: 'Text',
      pdfxtLabel: 'heading',
    });
  });
});
