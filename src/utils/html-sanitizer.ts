import sanitizeHtml from 'sanitize-html';

export const MAMMOTH_STYLE_MAP: string[] = [
  "p[style-name='Title'] => h1.doc-title",
  "p[style-name='Subtitle'] => h2.doc-subtitle",
  "p[style-name='Heading 1'] => h1",
  "p[style-name='Heading 2'] => h2",
  "p[style-name='Heading 3'] => h3",
  "p[style-name='Heading 4'] => h4",
  "p[style-name='Heading 5'] => h5",
  "p[style-name='Heading 6'] => h6",
  "p[style-name='heading 1'] => h1",
  "p[style-name='heading 2'] => h2",
  "p[style-name='heading 3'] => h3",
  "p[style-name='heading 4'] => h4",
  "p[style-name='List Paragraph'] => p.list-paragraph",
  "p[style-name='Quote'] => blockquote",
  "p[style-name='Intense Quote'] => blockquote.intense",
  "p[style-name='Block Text'] => blockquote",
  "p[style-name='Caption'] => p.caption",
  "p[style-name='No Spacing'] => p.no-spacing",
  "r[style-name='Strong'] => strong",
  "r[style-name='Emphasis'] => em",
  "r[style-name='Intense Emphasis'] => em.intense",
  "r[style-name='Subtle Reference'] => span.ref",
  "r[style-name='Book Title'] => em.book-title",
  "r[style-name='Superscript'] => sup",
  "r[style-name='Subscript'] => sub",
  "b => strong",
  "i => em",
  "u => u",
  "strike => s",
  "comment-reference => ",
];

export const HTML_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'sup', 'sub', 'span',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    span: ['class'],
    h1: ['class'],
    h2: ['class'],
    p: ['class'],
    blockquote: ['class'],
    em: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  disallowedTagsMode: 'discard',
};

export function sanitizeDocumentHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, HTML_SANITIZE_OPTIONS);
}
