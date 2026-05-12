import { describe, it, expect } from 'vitest';
import { validatePrhForbiddenTags } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/forbidden-tags-validator';
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
<head><title>x</title><style>b { color: red; }</style></head>
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

describe('validatePrhForbiddenTags', () => {
  it('emits zero issues for clean semantic markup', () => {
    const files = [file('ch1.xhtml', '<p>Clean <strong>bold</strong> and <em>italic</em>.</p>')];
    expect(validatePrhForbiddenTags(input(files))).toEqual([]);
  });

  it('emits PRH-MARKUP-DEPRECATED-TAG for <b> usage', () => {
    const files = [file('ch1.xhtml', '<p><b>bold</b></p>')];
    const issues = validatePrhForbiddenTags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-MARKUP-DEPRECATED-TAG');
    expect(issues[0].location).toBe('ch1.xhtml');
    expect(issues[0].message).toMatch(/<b>×1/);
  });

  it('aggregates counts across multiple deprecated tags in the same file', () => {
    const files = [file('ch1.xhtml', '<p><b>a</b><i>b</i><b>c</b><font>d</font></p>')];
    const issues = validatePrhForbiddenTags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/<b>×2/);
    expect(issues[0].message).toMatch(/<i>×1/);
    expect(issues[0].message).toMatch(/<font>×1/);
  });

  it('emits ONE issue per offending file (not per tag occurrence)', () => {
    const files = [
      file('a.xhtml', '<p><b>x</b><b>y</b><b>z</b></p>'),
      file('b.xhtml', '<p><i>x</i><i>y</i></p>'),
      file('clean.xhtml', '<p>clean</p>'),
    ];
    const issues = validatePrhForbiddenTags(input(files));
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.location).sort()).toEqual(['a.xhtml', 'b.xhtml']);
  });

  it('does NOT false-match <body>, <br>, <blockquote> (tag-boundary check)', () => {
    const files = [file('ch.xhtml', '<blockquote>quote</blockquote><br/>')];
    expect(validatePrhForbiddenTags(input(files))).toEqual([]);
  });

  it('does NOT match deprecated tag names inside <style> in head', () => {
    // The compliance-clean body still uses <strong>; the head has
    // `b { color: red; }` CSS which the validator MUST ignore.
    const files = [file('ch.xhtml', '<p><strong>bold</strong></p>')];
    expect(validatePrhForbiddenTags(input(files))).toEqual([]);
  });

  it('catches all deprecated tags (b/i/big/small/u/strike/s/center/font)', () => {
    const files = [
      file(
        'ch.xhtml',
        '<p><b>a</b><i>b</i><big>c</big><small>d</small><u>e</u><strike>f</strike><s>g</s><center>h</center><font>i</font></p>',
      ),
    ];
    const issues = validatePrhForbiddenTags(input(files));
    expect(issues).toHaveLength(1);
    // Total should be 9 tags.
    expect(issues[0].message).toMatch(/9 deprecated tag/);
  });

  it('matches self-closing tag variants (e.g. <b/>)', () => {
    const files = [file('ch.xhtml', '<p><b/>empty<i/></p>')];
    const issues = validatePrhForbiddenTags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/<b>×1/);
    expect(issues[0].message).toMatch(/<i>×1/);
  });
});
