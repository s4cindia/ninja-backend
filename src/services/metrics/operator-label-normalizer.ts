import { logger } from '../../lib/logger';
import type { CanonicalZoneType } from '../zone-extractor/types';

// Operator labels in the wild diverge from CanonicalZoneType because annotation
// was historically free-text. Two conventions exist in the corpus:
//   (A) PDF-tag-name style — LI, HDR, TOCI, P, etc. (uppercase)
//   (B) HTML-semantic style — h1..h6, list-item, toci, paragraph (lowercase)
// Neither maps cleanly to the 8 canonical types. Without normalization the
// mAP route bucketed ground-truth zones under non-canonical keys (e.g. "LI"),
// which have zero matching predictions, so AP=0 for every class. That is the
// root cause of the 0.0% mAP on Boyd-Hamill and Flanagan (audit 2026-05-12).
//
// This map intentionally lives in the metrics layer, not at the data-write
// boundary: we want to keep raw operator input in the DB column (history)
// while exposing a canonical view to anything that computes accuracy.
const LABEL_MAP: Record<string, CanonicalZoneType> = {
  // ── paragraph (body text + textual list/TOC/code/formula content) ──
  'paragraph':     'paragraph',
  'p':             'paragraph',
  'li':            'paragraph',
  'list-item':     'paragraph',
  'list_item':     'paragraph',
  'lbody':         'paragraph',
  'lbl':           'paragraph',
  'toci':          'paragraph',
  'toc':           'paragraph',
  'tocitem':       'paragraph',
  'code':          'paragraph',
  'formula':       'paragraph',
  'reference':     'paragraph',
  'bibentry':      'paragraph',
  'blockquote':    'paragraph',
  'quote':         'paragraph',
  'note':          'paragraph',
  // ── section-header (all heading levels collapse) ──
  'section-header': 'section-header',
  'sectionheader':  'section-header',
  'section_header': 'section-header',
  'h':              'section-header',
  'h1':             'section-header',
  'h2':             'section-header',
  'h3':             'section-header',
  'h4':             'section-header',
  'h5':             'section-header',
  'h6':             'section-header',
  'h7':             'section-header',
  'title':          'section-header',
  'heading':        'section-header',
  // ── table ──
  'table':          'table',
  'tr':             'table',
  'td':             'table',
  'th':             'table',
  'thead':          'table',
  'tbody':          'table',
  'tfoot':          'table',
  // ── figure ──
  'figure':         'figure',
  'fig':            'figure',
  'picture':        'figure',
  'image':          'figure',
  'img':            'figure',
  // ── caption ──
  'caption':        'caption',
  // ── footnote ──
  'footnote':       'footnote',
  'fn':             'footnote',
  'fenote':         'footnote',
  // ── running header ──
  'header':         'header',
  'page-header':    'header',
  'page_header':    'header',
  'pageheader':     'header',
  'hdr':            'header',
  // ── running footer ──
  'footer':         'footer',
  'page-footer':    'footer',
  'page_footer':    'footer',
  'pagefooter':     'footer',
  'ftr':            'footer',
};

const warnedUnknowns = new Set<string>();

/**
 * Normalize a free-text operator label to one of the 8 CanonicalZoneType
 * values. Returns null when the label is genuinely unrecognizable — caller
 * should treat that zone as having no usable ground-truth type and skip it
 * from mAP rather than silently miscount.
 */
export function normalizeOperatorLabel(label: string | null | undefined): CanonicalZoneType | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  if (!key) return null;
  const mapped = LABEL_MAP[key];
  if (mapped) return mapped;
  if (!warnedUnknowns.has(key)) {
    warnedUnknowns.add(key);
    logger.warn(`[OperatorLabelNormalizer] Unknown label "${label}" — excluded from mAP ground truth`);
  }
  return null;
}

// Exported only for tests that want to reset the dedup state between cases.
export function __resetWarnedUnknownsForTest(): void {
  warnedUnknowns.clear();
}
