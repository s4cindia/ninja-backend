import type { BBox, CanonicalZoneType } from '../types';

// Seam C — §3.2 Role → PDF tag mapping (+ heading-level inference).
//
// There is no central role→tag map in the codebase today — the write-path emits
// literal tag strings per call site. This is the one place the 11 detector classes
// become PDF structure tags.
//
// Two classes need more than a static map:
//   · section-header → the detector has a SINGLE header class; it does not tell
//     you H1 vs H3. `inferHeadingLevels` derives the level (§3.2).
//   · table / list-item → the map yields the container role; the child grid
//     (TR/TH/TD) and list wrapping (L>LI>LBody) are built in hierarchy assembly
//     (Phase 2), flagged here via `tableCell` / `listItem`.
//
// header / footer map to Artifact — pagination furniture, NOT a StructElem, so
// they never enter the /K reading flow even though they carry a readingOrder.

export type PdfTag =
  | 'P'
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  | 'Table'
  | 'Figure'
  | 'Caption'
  | 'Note'
  | 'L' | 'LI'
  | 'TOC' | 'TOCI'
  | 'Formula'
  | 'Artifact';

export interface TagMapping {
  tag: PdfTag;
  /** section-header — the concrete Hn is resolved by inferHeadingLevels. */
  isHeading?: boolean;
  /** header/footer — a pagination Artifact, excluded from the /K structure flow. */
  isArtifact?: boolean;
  /** list-item — wrapped under an L (with LBody) during hierarchy assembly. */
  listItem?: boolean;
  /** table — expands to TR/TH/TD during hierarchy assembly. */
  tableCell?: boolean;
}

const ROLE_MAP: Record<CanonicalZoneType, TagMapping> = {
  paragraph: { tag: 'P' },
  // Placeholder level; the real Hn comes from inferHeadingLevels.
  'section-header': { tag: 'H1', isHeading: true },
  table: { tag: 'Table', tableCell: true },
  figure: { tag: 'Figure' },
  caption: { tag: 'Caption' },
  footnote: { tag: 'Note' },
  header: { tag: 'Artifact', isArtifact: true },
  footer: { tag: 'Artifact', isArtifact: true },
  'list-item': { tag: 'LI', listItem: true },
  toci: { tag: 'TOCI' },
  formula: { tag: 'Formula' },
};

/** Map a canonical detector class to its PDF structure tag + assembly flags. */
export function canonicalToTag(zoneType: CanonicalZoneType): TagMapping {
  return ROLE_MAP[zoneType];
}

/** Compose the concrete heading tag (H1..H6) from an inferred 1..6 level. */
export function headingTag(level: number): PdfTag {
  const clamped = Math.min(6, Math.max(1, Math.round(level)));
  return (`H${clamped}`) as PdfTag;
}

export interface HeadingLevelConfig {
  /**
   * Relative height drop (fraction of a band's tallest height) that opens the
   * next heading level. 0.15 ⇒ a header ≥15% shorter than the band top is H(n+1).
   */
  tol: number;
  maxLevel: number;
}

export const DEFAULT_HEADING_CONFIG: HeadingLevelConfig = { tol: 0.15, maxLevel: 6 };

/**
 * Infer a heading level (1..6) per section-header zone.
 *
 * The detector emits no font size, so bbox HEIGHT is the size proxy: taller
 * header box ⇒ larger type ⇒ higher level. Distinct heights are clustered into
 * bands (tallest = H1) with a relative tolerance, capped at `maxLevel`.
 *
 * Caveat: a multi-line header inflates height, so this is a heuristic — good
 * enough for the Phase-0 spike; Phase 1 can refine with real pdfjs font metrics.
 *
 * @returns levels aligned to the input order (`levels[i]` for `headers[i]`).
 */
export function inferHeadingLevels(
  headers: Array<{ bbox: BBox }>,
  config: HeadingLevelConfig = DEFAULT_HEADING_CONFIG,
): number[] {
  if (headers.length === 0) return [];

  const uniqueDesc = [...new Set(headers.map((h) => h.bbox.h))].sort((a, b) => b - a);
  const heightToLevel = new Map<number, number>();
  let level = 1;
  let bandTop = uniqueDesc[0];
  for (const h of uniqueDesc) {
    if (bandTop - h > config.tol * bandTop) {
      level = Math.min(level + 1, config.maxLevel);
      bandTop = h;
    }
    heightToLevel.set(h, level);
  }

  return headers.map((h) => heightToLevel.get(h.bbox.h) as number);
}
