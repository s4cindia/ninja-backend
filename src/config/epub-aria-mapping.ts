export const EPUB_TYPE_TO_ARIA_ROLE: Record<string, string> = {
  'chapter': 'doc-chapter',
  'part': 'doc-part',
  'appendix': 'doc-appendix',
  'bibliography': 'doc-bibliography',
  'colophon': 'doc-colophon',
  'conclusion': 'doc-conclusion',
  'dedication': 'doc-dedication',
  'endnotes': 'doc-endnotes',
  'epilogue': 'doc-epilogue',
  'epigraph': 'doc-epigraph',
  'errata': 'doc-errata',
  'example': 'doc-example',
  'foreword': 'doc-foreword',
  'glossary': 'doc-glossary',
  'index': 'doc-index',
  'introduction': 'doc-introduction',
  'noteref': 'doc-noteref',
  'notice': 'doc-notice',
  'pagelist': 'doc-pagelist',
  'preface': 'doc-preface',
  'prologue': 'doc-prologue',
  'pullquote': 'doc-pullquote',
  'qna': 'doc-qna',
  'toc': 'doc-toc',
  'abstract': 'doc-abstract',
  'acknowledgments': 'doc-acknowledgments',
  'afterword': 'doc-afterword',
  'credit': 'doc-credit',
  'credits': 'doc-credits',
  'landmarks': 'navigation',
  'rearnotes': 'doc-endnotes',
  'sidebar': 'complementary',
  'footnote': 'note',
  'endnote': 'note',
  'rearnote': 'note',
};

export const SKIP_AUTO_ROLE_TYPES = new Set([
  'frontmatter',
  'bodymatter',
  'backmatter',
  'cover',
  'titlepage',
  'subtitle',
  'pagebreak',
  'loi',
  'lot',
  'tip',
  'footnotes',
  'page-list',
]);

export function getAriaRoleForEpubType(epubType: string): string {
  const normalized = epubType.toLowerCase();
  return EPUB_TYPE_TO_ARIA_ROLE[normalized] || `doc-${normalized}`;
}

export function shouldSkipAutoRole(epubType: string): boolean {
  return SKIP_AUTO_ROLE_TYPES.has(epubType.toLowerCase());
}
