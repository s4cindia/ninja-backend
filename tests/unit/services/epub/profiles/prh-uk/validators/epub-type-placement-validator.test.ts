import { describe, it, expect } from 'vitest';
import { validatePrhEpubTypePlacement } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/epub-type-placement-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(path: string, bodyAttrs: string, inner: string = ''): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body ${bodyAttrs}>${inner}</body>
</html>`,
  };
}

describe('validatePrhEpubTypePlacement — body epub:type whitelist', () => {
  it('emits zero issues for canonical transition types on <body>', () => {
    const files = [
      file('cover.xhtml', 'epub:type="cover"'),
      file('title.xhtml', 'epub:type="frontmatter"'),
      file('chapter1.xhtml', 'epub:type="bodymatter"'),
      file('about.xhtml', 'epub:type="backmatter"'),
    ];
    expect(validatePrhEpubTypePlacement(input(files))).toEqual([]);
  });

  it('emits PRH-MARKUP-EPUB-TYPE-MISPLACED for non-transition values on <body>', () => {
    const files = [file('chapter1.xhtml', 'epub:type="chapter"')];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED')).toBeDefined();
  });

  it('emits MISPLACED for "titlepage" on <body> (should be on section)', () => {
    const files = [file('title.xhtml', 'epub:type="titlepage"')];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED')).toBeDefined();
  });

  it('does NOT fire on files with no body epub:type', () => {
    const files = [file('nav.xhtml', '')];
    expect(validatePrhEpubTypePlacement(input(files))).toEqual([]);
  });

  it('rejects multi-token body epub:type ("frontmatter bodymatter") even when each token is in the whitelist (regression)', () => {
    // A single body can't simultaneously be two transitions. Without
    // the multi-token guard, both whitelisted tokens would silently
    // pass and inflate the duplicate-detection state.
    const files = [file('weird.xhtml', 'epub:type="frontmatter bodymatter"')];
    const issues = validatePrhEpubTypePlacement(input(files));
    const misplaced = issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED');
    expect(misplaced).toBeDefined();
    expect(misplaced?.message).toMatch(/2 transition tokens/i);
  });

  it('multi-token rejection does NOT also fire DUPLICATE on later legitimate uses', () => {
    // Regression: the duplicate tracker should not count the
    // multi-token file's tokens — otherwise a subsequent
    // <body epub:type="frontmatter"> would falsely fire DUPLICATE.
    const files = [
      file('weird.xhtml', 'epub:type="frontmatter bodymatter"'),
      file('legitimate.xhtml', 'epub:type="frontmatter"'),
    ];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-DUPLICATE')).toBeUndefined();
  });
});

describe('validatePrhEpubTypePlacement — duplicate transitions across <body>', () => {
  it('emits PRH-MARKUP-EPUB-TYPE-DUPLICATE when frontmatter appears twice', () => {
    const files = [
      file('cover.xhtml', 'epub:type="frontmatter"'),
      file('title.xhtml', 'epub:type="frontmatter"'),
    ];
    const issues = validatePrhEpubTypePlacement(input(files));
    const dup = issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-DUPLICATE');
    expect(dup).toBeDefined();
    expect(dup?.location).toBe('title.xhtml');
  });

  it('emits one DUPLICATE per extra occurrence (not just one issue regardless of count)', () => {
    const files = [
      file('cover.xhtml', 'epub:type="frontmatter"'),
      file('a.xhtml', 'epub:type="frontmatter"'),
      file('b.xhtml', 'epub:type="frontmatter"'),
    ];
    const issues = validatePrhEpubTypePlacement(input(files));
    const dups = issues.filter((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-DUPLICATE');
    expect(dups).toHaveLength(2);
  });

  it('does NOT emit DUPLICATE when each transition appears once', () => {
    const files = [
      file('cover.xhtml', 'epub:type="cover"'),
      file('title.xhtml', 'epub:type="frontmatter"'),
      file('chapter1.xhtml', 'epub:type="bodymatter"'),
      file('about.xhtml', 'epub:type="backmatter"'),
    ];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-DUPLICATE')).toBeUndefined();
  });
});

describe('validatePrhEpubTypePlacement — section epub:type forbidden list', () => {
  it('emits MISPLACED for <section epub:type="chapter">', () => {
    const files = [file('chapter1.xhtml', 'epub:type="bodymatter"', '<section epub:type="chapter"><h1>Ch 1</h1></section>')];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED' && /section epub:type="chapter"/.test(i.message))).toBeDefined();
  });

  it('emits MISPLACED for each forbidden section type: part, dedication, epigraph, appendix', () => {
    const files = [
      file('part1.xhtml', 'epub:type="bodymatter"', '<section epub:type="part"><h1>Part 1</h1></section>'),
      file('dedication.xhtml', 'epub:type="frontmatter"', '<section epub:type="dedication">To my mother</section>'),
      file('epigraph.xhtml', 'epub:type="frontmatter"', '<section epub:type="epigraph"><blockquote>quote</blockquote></section>'),
      file('appendix.xhtml', 'epub:type="backmatter"', '<section epub:type="appendix">Appendix A</section>'),
    ];
    const issues = validatePrhEpubTypePlacement(input(files));
    const misplaced = issues.filter((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED');
    expect(misplaced.length).toBeGreaterThanOrEqual(4);
  });

  it('does NOT emit on allowed section types (titlepage, copyright-page, footnotes)', () => {
    // Use one file per transition type — duplicates on body would
    // fire PRH-MARKUP-EPUB-TYPE-DUPLICATE which is a separate rule.
    const files = [
      file('title.xhtml', 'epub:type="frontmatter"', '<section epub:type="titlepage">T</section><section epub:type="copyright-page">C</section>'),
      file('notes.xhtml', 'epub:type="backmatter"', '<section epub:type="footnotes">F</section>'),
    ];
    expect(validatePrhEpubTypePlacement(input(files))).toEqual([]);
  });

  it('tolerates US spelling "acknowledgments" as forbidden too', () => {
    const files = [file('ack.xhtml', 'epub:type="backmatter"', '<section epub:type="acknowledgments">Thanks</section>')];
    const issues = validatePrhEpubTypePlacement(input(files));
    expect(issues.find((i) => i.code === 'PRH-MARKUP-EPUB-TYPE-MISPLACED')).toBeDefined();
  });
});
