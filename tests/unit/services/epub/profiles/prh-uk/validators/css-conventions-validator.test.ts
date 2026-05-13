import { describe, it, expect } from 'vitest';
import { validatePrhCssConventions } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/css-conventions-validator';
import type {
  PrhCssFile,
  PrhXhtmlFile,
} from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function cssFile(path: string, content: string, isPublisherOwned = true): PrhCssFile {
  return { path, content, isPublisherOwned };
}

function xhtmlFile(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

function input(opts: { cssFiles?: PrhCssFile[]; xhtmlFiles?: PrhXhtmlFile[] } = {}) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles: opts.xhtmlFiles ?? [],
    cssFiles: opts.cssFiles ?? [],
  };
}

describe('validatePrhCssConventions — PRH-CSS-BASESTYLES-RENAMED', () => {
  it('emits when no basestyles.css is present', () => {
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/core.css', 'body{}')] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-BASESTYLES-RENAMED')).toBe(true);
  });

  it('does NOT emit when basestyles.css exists', () => {
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/basestyles.css', 'body{}')] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-BASESTYLES-RENAMED')).toBe(false);
  });

  it('is case-insensitive on the filename', () => {
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/BaseStyles.css', 'body{}')] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-BASESTYLES-RENAMED')).toBe(false);
  });

  it('emits when basestyles.css exists OUTSIDE /styles', () => {
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/basestyles.css', 'body{}')] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-BASESTYLES-RENAMED')).toBe(true);
  });
});

describe('validatePrhCssConventions — PRH-CSS-IMPORT-ORDER-WRONG', () => {
  it('passes when @imports follow the canonical order', () => {
    const css = `
@import url("basestyles.css");
@import url("complex.css");
@import url("bespoke.css");
@import url("mediaquery.css");`;
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/basestyles.css', css)] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-IMPORT-ORDER-WRONG')).toBe(false);
  });

  it('passes when intermediate stages are skipped (basestyles → mediaquery)', () => {
    const css = `
@import "basestyles.css";
@import "mediaquery.css";`;
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/basestyles.css', css)] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-IMPORT-ORDER-WRONG')).toBe(false);
  });

  it('emits when mediaquery is imported BEFORE bespoke', () => {
    const css = `
@import "basestyles.css";
@import "mediaquery.css";
@import "bespoke.css";`;
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/basestyles.css', css)] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-IMPORT-ORDER-WRONG')).toBe(true);
  });

  it('ignores unknown stylesheet names alongside canonical ones', () => {
    const css = `
@import "basestyles.css";
@import "publisher_extras.css";
@import "mediaquery.css";`;
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/basestyles.css', css)] }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-IMPORT-ORDER-WRONG')).toBe(false);
  });

  it('passes when there are zero @import statements', () => {
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [cssFile('EPUB/styles/basestyles.css', 'p { color: black; }')],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-IMPORT-ORDER-WRONG')).toBe(false);
  });
});

describe('validatePrhCssConventions — PRH-CSS-CLASS-NAME-HYPHEN', () => {
  it('emits for hyphenated class selectors in publisher stylesheets', () => {
    const css = `.first-para { text-indent: 0; }`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-CLASS-NAME-HYPHEN')).toBe(true);
  });

  it('does NOT emit for underscored class selectors', () => {
    const css = `.first_para { text-indent: 0; } .section_break { margin: 1em; }`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-CLASS-NAME-HYPHEN')).toBe(false);
  });

  it('exempts vendor prefixes (tw-, bs-, ng-)', () => {
    const css = `.tw-flex { display: flex; } .bs-btn { padding: 8px; } .ng-cloak {}`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-CLASS-NAME-HYPHEN')).toBe(false);
  });

  it('ignores hyphenated classes declared in non-publisher stylesheets', () => {
    const css = `.btn-primary {} .modal-header {}`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/vendor/bootstrap.css', css, /* isPublisherOwned */ false),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-CLASS-NAME-HYPHEN')).toBe(false);
  });

  it('does NOT emit for single-token classes without hyphens', () => {
    const css = `.intro {} .chapter {} .footer {}`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-CLASS-NAME-HYPHEN')).toBe(false);
  });
});

describe('validatePrhCssConventions — PRH-CSS-PER-PARAGRAPH-FONT', () => {
  it('emits when a font-family class is used on 10+ paragraphs', () => {
    const css = `.scriptface { font-family: "Snell Roundhand", cursive; }`;
    const paras = Array.from({ length: 12 }, () => '<p class="scriptface">x</p>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT')).toBe(true);
  });

  it('does NOT emit when the font class is used on fewer than 10 paragraphs', () => {
    const css = `.scriptface { font-family: cursive; }`;
    const paras = Array.from({ length: 5 }, () => '<p class="scriptface">x</p>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT')).toBe(false);
  });

  it('does NOT emit when the font class is only applied to non-<p> elements', () => {
    const css = `.scriptface { font-family: cursive; }`;
    const body = Array.from({ length: 20 }, () => '<span class="scriptface">x</span>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', body)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT')).toBe(false);
  });

  it('aggregates paragraph counts across multiple XHTML files', () => {
    const css = `.scriptface { font-family: cursive; }`;
    const file1 = Array.from({ length: 6 }, () => '<p class="scriptface">x</p>').join('');
    const file2 = Array.from({ length: 6 }, () => '<p class="scriptface">y</p>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', file1), xhtmlFile('ch2.xhtml', file2)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT')).toBe(true);
  });

  it('extracts every class from a grouped selector (.a, .b { font-family })', () => {
    const css = `.scriptface_a, .scriptface_b { font-family: cursive; }`;
    const aParas = Array.from({ length: 6 }, () => '<p class="scriptface_a">x</p>').join('');
    const bParas = Array.from({ length: 6 }, () => '<p class="scriptface_b">y</p>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', aParas + bParas)],
      }),
    );
    const fontIssue = issues.find((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT');
    expect(fontIssue).toBeDefined();
    expect(fontIssue?.message).toMatch(/scriptface_a/);
    expect(fontIssue?.message).toMatch(/scriptface_b/);
  });

  it('handles the class appearing alongside other tokens in class="..."', () => {
    const css = `.scriptface { font-family: cursive; }`;
    const paras = Array.from(
      { length: 12 },
      () => '<p class="indent scriptface no_break">x</p>',
    ).join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', 'body{}'),
          cssFile('EPUB/styles/bespoke.css', css),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-PER-PARAGRAPH-FONT')).toBe(true);
  });
});

describe('validatePrhCssConventions — PRH-CSS-INLINE-STYLE-AT-SCALE', () => {
  it('emits when 100+ inline styles exist across all XHTML', () => {
    const paras = Array.from(
      { length: 110 },
      () => '<p style="color: red">x</p>',
    ).join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [cssFile('EPUB/styles/basestyles.css', 'body{}')],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-INLINE-STYLE-AT-SCALE')).toBe(true);
  });

  it('does NOT emit when inline-style count is below threshold', () => {
    const paras = Array.from(
      { length: 50 },
      () => '<p style="color: red">x</p>',
    ).join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [cssFile('EPUB/styles/basestyles.css', 'body{}')],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-INLINE-STYLE-AT-SCALE')).toBe(false);
  });

  it('aggregates inline styles across multiple files', () => {
    const partA = Array.from({ length: 60 }, () => '<p style="color: red">x</p>').join('');
    const partB = Array.from({ length: 60 }, () => '<p style="color: blue">y</p>').join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [cssFile('EPUB/styles/basestyles.css', 'body{}')],
        xhtmlFiles: [xhtmlFile('a.xhtml', partA), xhtmlFile('b.xhtml', partB)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-INLINE-STYLE-AT-SCALE')).toBe(true);
  });

  it('does NOT false-match data-style="…" attributes', () => {
    const paras = Array.from(
      { length: 110 },
      () => '<p data-style="emphasis">x</p>',
    ).join('');
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [cssFile('EPUB/styles/basestyles.css', 'body{}')],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', paras)],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-CSS-INLINE-STYLE-AT-SCALE')).toBe(false);
  });
});

describe('validatePrhCssConventions — issue shape', () => {
  it('carries the registered severity and a non-empty suggestion', () => {
    const issues = validatePrhCssConventions(
      input({ cssFiles: [cssFile('EPUB/styles/core.css', 'body{}')] }),
    );
    const basestylesIssue = issues.find((i) => i.code === 'PRH-CSS-BASESTYLES-RENAMED');
    expect(basestylesIssue?.severity).toBe('serious');
    expect(basestylesIssue?.suggestion.length ?? 0).toBeGreaterThan(0);
  });

  it('emits zero issues for a fully conformant EPUB', () => {
    const baseCss = `
@import url("complex.css");
@import url("bespoke.css");
@import url("mediaquery.css");
body { font-family: "Garamond", serif; }
.first_para { text-indent: 0; }
.section_break { margin: 1em; }`;
    const issues = validatePrhCssConventions(
      input({
        cssFiles: [
          cssFile('EPUB/styles/basestyles.css', baseCss),
          cssFile('EPUB/styles/bespoke.css', '.indent_topspace {}'),
        ],
        xhtmlFiles: [xhtmlFile('ch1.xhtml', '<p>Clean paragraph.</p>')],
      }),
    );
    expect(issues).toEqual([]);
  });
});
