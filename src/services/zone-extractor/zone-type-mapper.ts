import type { CanonicalZoneType } from './types';

const DOCLING_LABEL_MAP: Record<string, CanonicalZoneType> = {
  // Docling v2 labels (lowercase with underscores)
  'text':            'paragraph',
  'section_header':  'section-header',
  'table':           'table',
  'picture':         'figure',
  'caption':         'caption',
  'footnote':        'footnote',
  'page_header':     'header',
  'page_footer':     'footer',
  'list_item':       'paragraph',
  'formula':         'paragraph',
  'code':            'paragraph',
  'reference':       'paragraph',
  // Docling v1 labels (PascalCase with dashes) — keep for compatibility
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
