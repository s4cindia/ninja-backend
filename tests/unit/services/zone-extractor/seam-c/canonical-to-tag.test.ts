import { describe, it, expect } from 'vitest';
import {
  canonicalToTag,
  headingTag,
  inferHeadingLevels,
} from '../../../../../src/services/zone-extractor/seam-c/canonical-to-tag';
import type { CanonicalZoneType } from '../../../../../src/services/zone-extractor/types';

describe('canonicalToTag', () => {
  it('maps the plain block roles to their PDF tags', () => {
    expect(canonicalToTag('paragraph').tag).toBe('P');
    expect(canonicalToTag('figure').tag).toBe('Figure');
    expect(canonicalToTag('caption').tag).toBe('Caption');
    expect(canonicalToTag('footnote').tag).toBe('Note');
    expect(canonicalToTag('toci').tag).toBe('TOCI');
    expect(canonicalToTag('formula').tag).toBe('Formula');
  });

  it('flags section-header as a heading (level resolved separately)', () => {
    const m = canonicalToTag('section-header');
    expect(m.isHeading).toBe(true);
    expect(m.tag).toMatch(/^H[1-6]$/);
  });

  it('maps header and footer to a pagination Artifact, out of the /K flow', () => {
    for (const t of ['header', 'footer'] as CanonicalZoneType[]) {
      const m = canonicalToTag(t);
      expect(m.tag).toBe('Artifact');
      expect(m.isArtifact).toBe(true);
    }
  });

  it('flags list-item and table for hierarchy assembly', () => {
    expect(canonicalToTag('list-item')).toMatchObject({ tag: 'LI', listItem: true });
    expect(canonicalToTag('table')).toMatchObject({ tag: 'Table', tableCell: true });
  });

  it('covers every canonical class (no undefined mapping)', () => {
    const all: CanonicalZoneType[] = [
      'paragraph', 'section-header', 'table', 'figure', 'caption',
      'footnote', 'header', 'footer', 'list-item', 'toci', 'formula',
    ];
    for (const t of all) expect(canonicalToTag(t)?.tag).toBeTruthy();
  });
});

describe('headingTag', () => {
  it('composes H1..H6 from a level', () => {
    expect(headingTag(1)).toBe('H1');
    expect(headingTag(6)).toBe('H6');
  });
  it('clamps out-of-range levels into 1..6', () => {
    expect(headingTag(0)).toBe('H1');
    expect(headingTag(9)).toBe('H6');
    expect(headingTag(2.4)).toBe('H2');
  });
});

describe('inferHeadingLevels', () => {
  it('returns empty for no headers', () => {
    expect(inferHeadingLevels([])).toEqual([]);
  });

  it('assigns H1 to a lone header', () => {
    expect(inferHeadingLevels([{ bbox: { x: 0, y: 0, w: 100, h: 24 } }])).toEqual([1]);
  });

  it('ranks taller headers as higher levels (bigger = H1)', () => {
    const levels = inferHeadingLevels([
      { bbox: { x: 0, y: 0, w: 100, h: 30 } },
      { bbox: { x: 0, y: 0, w: 100, h: 20 } },
      { bbox: { x: 0, y: 0, w: 100, h: 12 } },
    ]);
    expect(levels).toEqual([1, 2, 3]);
  });

  it('preserves input order when heights are scrambled', () => {
    const levels = inferHeadingLevels([
      { bbox: { x: 0, y: 0, w: 100, h: 12 } }, // smallest
      { bbox: { x: 0, y: 0, w: 100, h: 30 } }, // largest
      { bbox: { x: 0, y: 0, w: 100, h: 20 } }, // middle
    ]);
    expect(levels).toEqual([3, 1, 2]);
  });

  it('groups near-equal heights into one level', () => {
    expect(
      inferHeadingLevels([
        { bbox: { x: 0, y: 0, w: 100, h: 24 } },
        { bbox: { x: 0, y: 0, w: 100, h: 24 } },
      ]),
    ).toEqual([1, 1]);
  });

  it('caps deep hierarchies at H6', () => {
    const heights = [60, 50, 40, 30, 20, 15, 10, 5];
    const levels = inferHeadingLevels(heights.map((h) => ({ bbox: { x: 0, y: 0, w: 100, h } })));
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 6, 6]);
  });
});
