export const AUTO_FIXABLE_ISSUE_CODES = new Set([
  'EPUB-META-001',
  'EPUB-META-002',
  'EPUB-META-003',
  'EPUB-META-004',
  'EPUB-SEM-001',
  'EPUB-SEM-002',
  'EPUB-IMG-001',
  'EPUB-STRUCT-002',
  'EPUB-STRUCT-003',
  'EPUB-STRUCT-004',
  'EPUB-NAV-001',
  'EPUB-FIG-001',
]);

export const MODIFICATION_TYPE_TO_ISSUE_CODE: Record<string, string> = {
  'add_language': 'EPUB-META-001',
  'add_accessibility_metadata': 'EPUB-META-002',
  'add_accessibility_summary': 'EPUB-META-003',
  'add_access_modes': 'EPUB-META-004',
  'add_html_lang': 'EPUB-SEM-001',
  'fix_empty_links': 'EPUB-SEM-002',
  'add_alt_text': 'EPUB-IMG-001',
  'add_table_headers': 'EPUB-STRUCT-002',
  'fix_heading_hierarchy': 'EPUB-STRUCT-003',
  'add_aria_landmarks': 'EPUB-STRUCT-004',
  'add_skip_navigation': 'EPUB-NAV-001',
  'add_figure_structure': 'EPUB-FIG-001',
};
