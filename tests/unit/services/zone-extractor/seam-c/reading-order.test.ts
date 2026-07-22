import { describe, it, expect } from 'vitest';
import {
  synthesizeReadingOrder,
  type OrderableZone,
} from '../../../../../src/services/zone-extractor/seam-c/reading-order';
import type { CanonicalZoneType } from '../../../../../src/services/zone-extractor/types';

// bbox is PDF points, top-left origin: {x, y, w, h}. Smaller y = higher on page.
const z = (
  pageNumber: number,
  x: number,
  y: number,
  w: number,
  h: number,
  zoneType: CanonicalZoneType = 'paragraph',
): OrderableZone => ({ pageNumber, bbox: { x, y, w, h }, zoneType });

// Convenience: run the synthesizer and return the zones in reading order.
const order = (zones: OrderableZone[]): OrderableZone[] =>
  synthesizeReadingOrder(zones).map((o) => o.zone);

describe('synthesizeReadingOrder', () => {
  it('returns empty for no zones', () => {
    expect(synthesizeReadingOrder([])).toEqual([]);
  });

  it('orders a single-column page top-to-bottom regardless of input order', () => {
    const a = z(1, 50, 300, 400, 40); // bottom
    const b = z(1, 50, 100, 400, 40); // top
    const c = z(1, 50, 200, 400, 40); // middle
    expect(order([a, b, c])).toEqual([b, c, a]);
  });

  it('orders a two-column page left-column-first, each column top-to-bottom', () => {
    const l1 = z(1, 50, 100, 200, 40);
    const l2 = z(1, 50, 200, 200, 40);
    const r1 = z(1, 320, 100, 200, 40);
    const r2 = z(1, 320, 200, 200, 40);
    // Feed in a scrambled order to prove ordering isn't input-dependent.
    expect(order([r2, l1, r1, l2])).toEqual([l1, l2, r1, r2]);
  });

  it('emits a full-width header before the columns beneath it', () => {
    const header = z(1, 50, 40, 470, 30, 'section-header'); // spans both columns
    const l1 = z(1, 50, 100, 200, 40);
    const r1 = z(1, 320, 100, 200, 40);
    expect(order([l1, r1, header])).toEqual([header, l1, r1]);
  });

  it('emits a full-width footer after the columns above it', () => {
    const l1 = z(1, 50, 100, 200, 40);
    const r1 = z(1, 320, 100, 200, 40);
    const footer = z(1, 50, 700, 470, 30, 'footer');
    expect(order([footer, r1, l1])).toEqual([l1, r1, footer]);
  });

  it('splits bands at a full-width divider (col → wide table → col)', () => {
    const l1 = z(1, 50, 100, 200, 40);
    const r1 = z(1, 320, 100, 200, 40);
    const table = z(1, 50, 250, 470, 80, 'table'); // full-width spanner
    const l2 = z(1, 50, 380, 200, 40);
    const r2 = z(1, 320, 380, 200, 40);
    expect(order([r2, l1, table, r1, l2])).toEqual([l1, r1, table, l2, r2]);
  });

  it('orders page-major across pages, ascending page number', () => {
    const p2 = z(2, 50, 100, 400, 40);
    const p1 = z(1, 50, 100, 400, 40);
    const result = synthesizeReadingOrder([p2, p1]);
    expect(result.map((o) => o.zone)).toEqual([p1, p2]);
    expect(result.map((o) => o.readingOrder)).toEqual([0, 1]);
  });

  it('assigns a contiguous global readingOrder index', () => {
    const zones = [
      z(1, 50, 200, 400, 40),
      z(1, 50, 100, 400, 40),
      z(2, 50, 100, 400, 40),
    ];
    const result = synthesizeReadingOrder(zones);
    expect(result.map((o) => o.readingOrder)).toEqual([0, 1, 2]);
  });
});
