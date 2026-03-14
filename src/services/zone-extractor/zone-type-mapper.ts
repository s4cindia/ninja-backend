import type { CanonicalZoneType } from './types';

const DOCLING_LABEL_MAP: Record<string, CanonicalZoneType> = {
  'Text':           'paragraph',
  'Section-Header': 'section-header',
  'Table':          'table',
  'Picture':        'figure',
  'Caption':        'caption',
  'Footnote':       'footnote',
  'Page-Header':    'header',
  'Page-Footer':    'footer',
};

export function mapDoclingLabel(label: string): CanonicalZoneType {
  const mapped = DOCLING_LABEL_MAP[label];
  if (mapped) return mapped;

  console.warn(
    `[ZoneTypeMapper] Unknown Docling label "${label}" — defaulting to paragraph`,
  );
  return 'paragraph';
}
