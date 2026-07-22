import type { OrderableZone, OrderedZone } from './reading-order';
import {
  canonicalToTag,
  headingTag,
  inferHeadingLevels,
  type PdfTag,
  type TagMapping,
} from './canonical-to-tag';

// Seam C — Phase 2a: hierarchy assembly.
//
// A detector emits a FLAT reading-ordered list of typed regions. A /StructTreeRoot
// is a TREE: list items nest under an `L`, TOC entries under a `TOC`, etc. This
// step groups the flat, tag-resolved sequence into that container forest — still
// pure data, no PDF writing (that is Phase 2b `buildStructTreeFromZones`).
//
// Grouping rules (single detector class per region, so grouping is by adjacency):
//   · a run of consecutive `list-item`s  → one `L` of `LI`s
//   · a run of consecutive `TOCI`s       → one `TOC`
//   · header/footer                       → `Artifact` (kept, but out of the /K flow)
//   · table                               → `Table` leaf (TR/TH/TD grid needs cell
//                                            geometry the detector doesn't emit — a
//                                            later sub-step; see note below)
//   · everything else                     → a leaf block with its resolved tag
//
// Adjacency is a heuristic: two truly separate lists that abut become one `L`. For
// the simple single-column PDFs Phase 2 targets that is acceptable; a later pass can
// split on vertical gaps / indentation.

export type StructNode =
  | { kind: 'block'; tag: PdfTag; zone: OrderableZone }
  | { kind: 'list'; children: StructNode[] }        // L
  | { kind: 'listItem'; zone: OrderableZone }        // LI (expands to LI>LBody at write time)
  | { kind: 'toc'; children: StructNode[] }          // TOC
  | { kind: 'tocItem'; zone: OrderableZone }          // TOCI
  | { kind: 'table'; zone: OrderableZone }            // Table (cell grid = later)
  | { kind: 'artifact'; zone: OrderableZone };        // header/footer — pagination

export interface TaggedZone {
  zone: OrderableZone;
  tag: PdfTag;
  mapping: TagMapping;
}

/**
 * Resolve each ordered zone to its PDF tag, inferring heading levels across the
 * whole document so `section-header` becomes a concrete H1..H6.
 */
export function tagOrderedZones(ordered: OrderedZone<OrderableZone>[]): TaggedZone[] {
  const headers = ordered.filter((o) => o.zone.zoneType === 'section-header').map((o) => o.zone);
  const levels = inferHeadingLevels(headers);
  const levelByZone = new Map<OrderableZone, number>();
  headers.forEach((h, i) => levelByZone.set(h, levels[i]));

  return ordered.map((o) => {
    const mapping = canonicalToTag(o.zone.zoneType);
    const tag = mapping.isHeading ? headingTag(levelByZone.get(o.zone) ?? 1) : mapping.tag;
    return { zone: o.zone, tag, mapping };
  });
}

/**
 * Group a reading-ordered, tag-resolved sequence into the container forest.
 * Invariant: at most one of the list / TOC runs is open at any time (each item
 * type only extends its own run), so a single flush() that closes both is safe.
 */
export function assembleHierarchy(tagged: TaggedZone[]): StructNode[] {
  const out: StructNode[] = [];
  let listRun: StructNode[] = [];
  let tocRun: StructNode[] = [];

  const flush = (): void => {
    if (listRun.length) { out.push({ kind: 'list', children: listRun }); listRun = []; }
    if (tocRun.length) { out.push({ kind: 'toc', children: tocRun }); tocRun = []; }
  };

  for (const t of tagged) {
    if (t.mapping.listItem) {
      if (tocRun.length) flush();           // switching TOC → list
      listRun.push({ kind: 'listItem', zone: t.zone });
    } else if (t.tag === 'TOCI') {
      if (listRun.length) flush();           // switching list → TOC
      tocRun.push({ kind: 'tocItem', zone: t.zone });
    } else {
      flush();                               // any other block closes an open run
      if (t.mapping.isArtifact) out.push({ kind: 'artifact', zone: t.zone });
      else if (t.mapping.tableCell) out.push({ kind: 'table', zone: t.zone });
      else out.push({ kind: 'block', tag: t.tag, zone: t.zone });
    }
  }
  flush();
  return out;
}

/** Convenience: reading-ordered `OrderedZone[]` → the container forest. */
export function assembleFromOrdered(ordered: OrderedZone<OrderableZone>[]): StructNode[] {
  return assembleHierarchy(tagOrderedZones(ordered));
}
