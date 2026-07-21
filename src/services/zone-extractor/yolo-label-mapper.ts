import type { CanonicalZoneType } from './types';

// The YOLO zone-detector already emits CanonicalZoneType values — its class
// names ARE the 11 canonical types (training-export CLASS_MAP). This validates
// the incoming label and passes it through, defaulting anything unexpected to
// 'paragraph' with a warning — mirroring mapDoclingLabel / mapPdfxtLabel so a
// drifted label is surfaced rather than silently trusted.
const CANONICAL: ReadonlySet<string> = new Set<CanonicalZoneType>([
  'paragraph', 'section-header', 'table', 'figure', 'caption',
  'footnote', 'header', 'footer', 'list-item', 'toci', 'formula',
]);

export function mapYoloLabel(label: string): CanonicalZoneType {
  const key = label.trim().toLowerCase();
  if (CANONICAL.has(key)) return key as CanonicalZoneType;
  console.warn(`[YoloMapper] Unknown YOLO label "${label}" — defaulting to paragraph`);
  return 'paragraph';
}
