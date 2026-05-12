import { describe, it, expect } from 'vitest';
import { validatePrhPageBreakShape } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/page-break-shape-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(body: string): PrhXhtmlFile {
  return {
    path: 'chapter1.xhtml',
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

describe('validatePrhPageBreakShape — happy paths', () => {
  it('emits zero issues for canonical pagebreak markup', () => {
    const files = [file('<p>page <span epub:type="pagebreak" role="doc-pagebreak" aria-label="12"/> here</p>')];
    expect(validatePrhPageBreakShape(input(files))).toEqual([]);
  });

  it('accepts self-closing and explicit-close variants identically', () => {
    const files = [
      file('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="1"/>'),
      file('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="2"></span>'),
    ];
    expect(validatePrhPageBreakShape(input(files))).toEqual([]);
  });

  it('accepts role="doc-pagebreak region" (multi-value role)', () => {
    const files = [file('<span epub:type="pagebreak" role="doc-pagebreak region" aria-label="12"/>')];
    expect(validatePrhPageBreakShape(input(files))).toEqual([]);
  });

  it('does NOT fire on files with no pagebreak spans', () => {
    const files = [file('<p>plain content</p>')];
    expect(validatePrhPageBreakShape(input(files))).toEqual([]);
  });
});

describe('validatePrhPageBreakShape — malformed cases', () => {
  it('emits PRH-PAGEBREAK-MALFORMED when role is missing entirely', () => {
    const files = [file('<span epub:type="pagebreak" aria-label="12"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-PAGEBREAK-MALFORMED');
    expect(issues[0].message).toMatch(/role attribute is missing/i);
  });

  it('emits PRH-PAGEBREAK-MALFORMED when role lacks doc-pagebreak token', () => {
    const files = [file('<span epub:type="pagebreak" role="region" aria-label="12"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/missing the doc-pagebreak token/i);
  });

  it('emits PRH-PAGEBREAK-MALFORMED when aria-label is missing', () => {
    const files = [file('<span epub:type="pagebreak" role="doc-pagebreak"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/aria-label is missing/i);
  });

  it('emits PRH-PAGEBREAK-MALFORMED when aria-label has "page " prefix', () => {
    const files = [file('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="page 12"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/not a bare digit sequence/i);
  });

  it('emits PRH-PAGEBREAK-MALFORMED for roman-numeral aria-label ("xii")', () => {
    const files = [file('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="xii"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/not a bare digit sequence/i);
  });

  it('emits one issue per malformed pagebreak (high-volume rule)', () => {
    const files = [file(`
      <span epub:type="pagebreak" aria-label="1"/>
      <span epub:type="pagebreak" role="doc-pagebreak" aria-label="page 2"/>
      <span epub:type="pagebreak" role="doc-pagebreak" aria-label="3"/>
    `)];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(2);
  });

  it('aggregates BOTH role-and-aria-label problems into the same issue when both are wrong', () => {
    const files = [file('<span epub:type="pagebreak" role="region" aria-label="page 12"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/doc-pagebreak/i);
    expect(issues[0].message).toMatch(/bare digit/i);
  });

  it('does NOT false-match `data-role="doc-pagebreak"` (regex anchor regression)', () => {
    // Whitespace-anchored regex prevents `data-role` from satisfying
    // the role check. Without that anchor, the pagebreak would
    // silently pass and a real malformed pagebreak goes unflagged.
    const files = [file('<span epub:type="pagebreak" data-role="doc-pagebreak" aria-label="12"/>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/role attribute is missing/i);
  });

  it('does NOT treat `data-epub:type="pagebreak"` as a real pagebreak (regression)', () => {
    // Prefixed attributes like data-epub:type are author-defined
    // metadata, not the canonical epub:type. The validator must skip
    // the span entirely so it doesn't fire spurious malformed-pagebreak
    // issues against arbitrary metadata-only spans.
    const files = [file('<span data-epub:type="pagebreak">12</span>')];
    const issues = validatePrhPageBreakShape(input(files));
    expect(issues).toEqual([]);
  });
});
