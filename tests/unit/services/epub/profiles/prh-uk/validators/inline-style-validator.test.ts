import { describe, it, expect } from 'vitest';
import { validatePrhInlineStyles } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/inline-style-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

describe('validatePrhInlineStyles', () => {
  it('emits zero issues for clean markup (no inline styles)', () => {
    const files = [file('ch.xhtml', '<p class="text">clean</p>')];
    expect(validatePrhInlineStyles(input(files))).toEqual([]);
  });

  it('emits PRH-MARKUP-INLINE-STYLE for a single style attribute', () => {
    const files = [file('ch.xhtml', '<p style="color: red">red</p>')];
    const issues = validatePrhInlineStyles(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-MARKUP-INLINE-STYLE');
    expect(issues[0].location).toBe('ch.xhtml');
    expect(issues[0].message).toMatch(/1 inline style/);
  });

  it('aggregates count across multiple inline styles in the same file', () => {
    const files = [file('ch.xhtml', '<p style="a"></p><span style="b"></span><div style="c"></div>')];
    const issues = validatePrhInlineStyles(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/3 inline style/);
  });

  it('emits ONE issue per offending file (not per attribute)', () => {
    const files = [
      file('a.xhtml', '<p style="a"></p><p style="b"></p>'),
      file('b.xhtml', '<p style="c"></p>'),
      file('clean.xhtml', '<p>clean</p>'),
    ];
    const issues = validatePrhInlineStyles(input(files));
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.location).sort()).toEqual(['a.xhtml', 'b.xhtml']);
  });

  it('does NOT false-match data-style / data-base-style attributes', () => {
    const files = [file('ch.xhtml', '<p data-style="x" data-base-style="y">text</p>')];
    expect(validatePrhInlineStyles(input(files))).toEqual([]);
  });

  it('matches single-quoted style attributes', () => {
    const files = [file('ch.xhtml', "<p style='color: red'>red</p>")];
    expect(validatePrhInlineStyles(input(files))).toHaveLength(1);
  });

  it('does NOT false-match <style> ELEMENTS in <head>', () => {
    // <style>…</style> doesn't have an `=` after the word "style", so
    // the regex correctly skips it. But verify defensively.
    const files: PrhXhtmlFile[] = [
      {
        path: 'ch.xhtml',
        content: '<html><head><style>p { color: red; }</style></head><body><p>x</p></body></html>',
      },
    ];
    expect(validatePrhInlineStyles(input(files))).toEqual([]);
  });
});
