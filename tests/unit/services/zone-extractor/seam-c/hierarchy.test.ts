import { describe, it, expect } from 'vitest';
import {
  assembleHierarchy,
  tagOrderedZones,
  assembleFromOrdered,
  type TaggedZone,
  type StructNode,
} from '../../../../../src/services/zone-extractor/seam-c/hierarchy';
import { canonicalToTag } from '../../../../../src/services/zone-extractor/seam-c/canonical-to-tag';
import type { OrderableZone, OrderedZone } from '../../../../../src/services/zone-extractor/seam-c/reading-order';
import type { CanonicalZoneType } from '../../../../../src/services/zone-extractor/types';

const zone = (zoneType: CanonicalZoneType, h = 12): OrderableZone => ({
  pageNumber: 1,
  bbox: { x: 0, y: 0, w: 100, h },
  zoneType,
});

// Build TaggedZone[] straight from canonical types (heading level not under test here).
const tag = (zoneType: CanonicalZoneType): TaggedZone => {
  const z = zone(zoneType);
  const mapping = canonicalToTag(zoneType);
  return { zone: z, tag: mapping.tag, mapping };
};

const kinds = (nodes: StructNode[]): string[] => nodes.map((n) => n.kind);

describe('assembleHierarchy', () => {
  it('wraps a run of list-items in a single L', () => {
    const nodes = assembleHierarchy([tag('list-item'), tag('list-item'), tag('list-item')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('list');
    const list = nodes[0] as Extract<StructNode, { kind: 'list' }>;
    expect(list.children.map((c) => c.kind)).toEqual(['listItem', 'listItem', 'listItem']);
  });

  it('splits two list runs separated by a paragraph into two Ls', () => {
    const nodes = assembleHierarchy([
      tag('list-item'), tag('list-item'),
      tag('paragraph'),
      tag('list-item'), tag('list-item'),
    ]);
    expect(kinds(nodes)).toEqual(['list', 'block', 'list']);
  });

  it('wraps a run of TOCI in a single TOC', () => {
    const nodes = assembleHierarchy([tag('toci'), tag('toci')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('toc');
    expect((nodes[0] as Extract<StructNode, { kind: 'toc' }>).children.map((c) => c.kind))
      .toEqual(['tocItem', 'tocItem']);
  });

  it('flushes cleanly when switching directly from a list to a TOC', () => {
    const nodes = assembleHierarchy([tag('list-item'), tag('toci'), tag('list-item')]);
    expect(kinds(nodes)).toEqual(['list', 'toc', 'list']);
  });

  it('emits header/footer as Artifact nodes, never inside a list', () => {
    const nodes = assembleHierarchy([tag('list-item'), tag('header'), tag('list-item')]);
    expect(kinds(nodes)).toEqual(['list', 'artifact', 'list']);
    expect((nodes[1] as Extract<StructNode, { kind: 'artifact' }>).zone.zoneType).toBe('header');
  });

  it('emits table and figure/paragraph/formula as their own leaf nodes', () => {
    const nodes = assembleHierarchy([tag('table'), tag('figure'), tag('paragraph'), tag('formula')]);
    expect(kinds(nodes)).toEqual(['table', 'block', 'block', 'block']);
    const blocks = nodes.filter((n) => n.kind === 'block') as Extract<StructNode, { kind: 'block' }>[];
    expect(blocks.map((b) => b.tag)).toEqual(['Figure', 'P', 'Formula']);
  });

  it('closes an open list at end of sequence', () => {
    const nodes = assembleHierarchy([tag('paragraph'), tag('list-item')]);
    expect(kinds(nodes)).toEqual(['block', 'list']);
  });

  it('returns empty for no zones', () => {
    expect(assembleHierarchy([])).toEqual([]);
  });
});

describe('tagOrderedZones', () => {
  const ord = (zoneType: CanonicalZoneType, h = 12): OrderedZone<OrderableZone> => ({
    zone: { pageNumber: 1, bbox: { x: 0, y: 0, w: 100, h }, zoneType },
    readingOrder: 0,
  });

  it('resolves section-headers to concrete H-levels by height (taller = higher)', () => {
    const tagged = tagOrderedZones([ord('section-header', 30), ord('section-header', 20), ord('section-header', 12)]);
    expect(tagged.map((t) => t.tag)).toEqual(['H1', 'H2', 'H3']);
  });

  it('resolves plain classes via the role map', () => {
    const tagged = tagOrderedZones([ord('paragraph'), ord('footnote'), ord('formula')]);
    expect(tagged.map((t) => t.tag)).toEqual(['P', 'Note', 'Formula']);
  });
});

describe('assembleFromOrdered', () => {
  it('chains tag-resolution and grouping end-to-end', () => {
    const ordered: OrderedZone<OrderableZone>[] = [
      { zone: zone('section-header', 24), readingOrder: 0 },
      { zone: zone('list-item'), readingOrder: 1 },
      { zone: zone('list-item'), readingOrder: 2 },
      { zone: zone('footer'), readingOrder: 3 },
    ];
    const nodes = assembleFromOrdered(ordered);
    expect(kinds(nodes)).toEqual(['block', 'list', 'artifact']);
    expect((nodes[0] as Extract<StructNode, { kind: 'block' }>).tag).toBe('H1');
  });
});
