import { describe, it, expect } from 'vitest';
import { validatePrhFootnoteIdParity } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/footnote-id-parity-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function chapterWithRef(refHref: string): PrhXhtmlFile {
  return {
    path: 'chapter1.xhtml',
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="bodymatter">
  <p>See note.<a epub:type="noteref" href="${refHref}">1</a></p>
</body>
</html>`,
  };
}

function footnotesFileWithIds(ids: string[]): PrhXhtmlFile {
  const items = ids.map((id) => `<aside epub:type="footnote" id="${id}" role="doc-footnote">Note ${id}</aside>`).join('\n');
  return {
    path: 'footnotes.xhtml',
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="backmatter">${items}</body>
</html>`,
  };
}

function endnotesFileWithIds(ids: string[]): PrhXhtmlFile {
  const items = ids.map((id) => `<li id="${id}">Endnote ${id}</li>`).join('\n');
  return {
    path: 'endnotes.xhtml',
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="backmatter">
  <section epub:type="endnotes">
    <ol>${items}</ol>
  </section>
</body>
</html>`,
  };
}

describe('validatePrhFootnoteIdParity — happy paths', () => {
  it('emits zero issues when noteref points at an existing footnote aside id', () => {
    const files = [chapterWithRef('#fn1'), footnotesFileWithIds(['fn1', 'fn2'])];
    expect(validatePrhFootnoteIdParity(input(files))).toEqual([]);
  });

  it('emits zero issues when noteref points at an endnotes <li> id', () => {
    const files = [chapterWithRef('#en1'), endnotesFileWithIds(['en1', 'en2'])];
    expect(validatePrhFootnoteIdParity(input(files))).toEqual([]);
  });

  it('accepts cross-file refs (chapter1.xhtml#fn1 style)', () => {
    const files = [chapterWithRef('footnotes.xhtml#fn1'), footnotesFileWithIds(['fn1'])];
    expect(validatePrhFootnoteIdParity(input(files))).toEqual([]);
  });
});

describe('validatePrhFootnoteIdParity — orphan detection', () => {
  it('emits PRH-FOOTNOTE-ID-MISMATCH when ref points at a missing id', () => {
    const files = [chapterWithRef('#fn99'), footnotesFileWithIds(['fn1', 'fn2'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-FOOTNOTE-ID-MISMATCH');
    expect(issues[0].location).toBe('chapter1.xhtml');
    expect(issues[0].message).toMatch(/#fn99/);
  });

  it('emits one issue PER orphan ref (high-volume rule)', () => {
    const chapter: PrhXhtmlFile = {
      path: 'chapter1.xhtml',
      content: `<html xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="bodymatter">
        <p><a epub:type="noteref" href="#fn1">1</a></p>
        <p><a epub:type="noteref" href="#fn99">99</a></p>
        <p><a epub:type="noteref" href="#fn100">100</a></p>
      </body></html>`,
    };
    const files = [chapter, footnotesFileWithIds(['fn1'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.code === 'PRH-FOOTNOTE-ID-MISMATCH')).toBe(true);
  });

  it('emits PRH-FOOTNOTE-ID-MISMATCH when noteref has no href at all', () => {
    const broken: PrhXhtmlFile = {
      path: 'chapter1.xhtml',
      content: `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><p><a epub:type="noteref">1</a></p></body></html>`,
    };
    const files = [broken, footnotesFileWithIds(['fn1'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/no href/i);
  });

  it('emits PRH-FOOTNOTE-ID-MISMATCH when noteref href is an external URL (no fragment)', () => {
    const files = [chapterWithRef('https://example.com/notes'), footnotesFileWithIds(['fn1'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/example\.com/);
  });

  it('emits PRH-FOOTNOTE-ID-MISMATCH for external URL + fragment (https://…#fn1) — regression', () => {
    // Without an external-URL guard, parseFragmentId would extract
    // "fn1" from the URL and silently match an in-EPUB footnote
    // with id="fn1", hiding the real broken-link bug.
    const files = [chapterWithRef('https://example.com/notes#fn1'), footnotesFileWithIds(['fn1'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-FOOTNOTE-ID-MISMATCH');
    expect(issues[0].message).toMatch(/example\.com/);
  });

  it('rejects protocol-relative URLs (//host/path)', () => {
    const files = [chapterWithRef('//example.com/notes#fn1'), footnotesFileWithIds(['fn1'])];
    const issues = validatePrhFootnoteIdParity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-FOOTNOTE-ID-MISMATCH');
  });
});

describe('validatePrhFootnoteIdParity — id-set scope', () => {
  it('does NOT add <li id="…"> from non-endnotes sections to the id-set', () => {
    // A regular bullet-list <li id="something"> shouldn't satisfy a
    // noteref pointing at "something". Only <li> inside
    // <section epub:type="endnotes"> count.
    const chapter: PrhXhtmlFile = {
      path: 'chapter1.xhtml',
      content: `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><p><a epub:type="noteref" href="#bullet1">1</a></p>
        <ul><li id="bullet1">Just a regular list item</li></ul></body></html>`,
    };
    const issues = validatePrhFootnoteIdParity(input([chapter]));
    expect(issues.find((i) => i.code === 'PRH-FOOTNOTE-ID-MISMATCH')).toBeDefined();
  });

  it('accepts a footnote that lives in the SAME file as the ref', () => {
    const file: PrhXhtmlFile = {
      path: 'chapter1.xhtml',
      content: `<html xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="bodymatter">
        <p>see note<a epub:type="noteref" href="#fn1">1</a></p>
        <aside epub:type="footnote" id="fn1" role="doc-footnote">A footnote.</aside>
      </body></html>`,
    };
    expect(validatePrhFootnoteIdParity(input([file]))).toEqual([]);
  });
});
