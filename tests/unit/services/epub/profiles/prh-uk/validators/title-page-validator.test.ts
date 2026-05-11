import { describe, it, expect } from 'vitest';
import { validatePrhTitlePage } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/title-page-validator';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';
import type { ImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/_types';

/** Penguin title.xhtml variant — full structure (author + title + subtitle). */
function penguinTitleVariant1(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Title</title></head>
<body epub:type="frontmatter">
  <section epub:type="titlepage" class="titlepage">
    <h2>Author Name</h2>
    <hr/>
    <h3 class="booktitle">BOOK TITLE</h3>
    <h4 class="booksubtitle">Subtitle</h4>
    <figure class="imprint_logo">
      <img src="images/title_page_logo.png" alt="Penguin Random House" />
    </figure>
  </section>
</body>
</html>`;
}

/** Penguin title_5.xhtml variant — no author byline, title + contributor only. */
function penguinTitleVariant5(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Title</title></head>
<body epub:type="frontmatter">
  <section epub:type="titlepage" class="titlepage">
    <h3 class="booktitle">BOOK TITLE</h3>
    <p>edited by Editor Name</p>
    <figure class="imprint_logo">
      <img src="images/title_page_logo.png" alt="Penguin Random House" />
    </figure>
  </section>
</body>
</html>`;
}

function puffinImageOnlyTitlePage(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Title</title></head>
<body epub:type="frontmatter">
  <figure class="image_full">
    <img alt="The Victory Dogs by Megan Rix" src="images/half.jpg" />
  </figure>
</body>
</html>`;
}

function input(files: PrhXhtmlFile[], imprintRules: ImprintRules) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test Book',
    xhtmlFiles: files,
    imprintRules,
  };
}

describe('validatePrhTitlePage — Penguin structured', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits zero issues for variant 1 (author + title + subtitle)', () => {
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title.xhtml', content: penguinTitleVariant1() };
    expect(validatePrhTitlePage(input([file], penguinRules))).toEqual([]);
  });

  it('emits zero issues for variant 5 (title + contributor, no author)', () => {
    // Soft fingerprint match — drops the author byline but keeps the
    // core structure. The 6 Penguin variants should all pass.
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title_5.xhtml', content: penguinTitleVariant5() };
    expect(validatePrhTitlePage(input([file], penguinRules))).toEqual([]);
  });

  it('emits PRH-TITLE-PAGE-MISSING when no titlepage section is present', () => {
    const issues = validatePrhTitlePage(input([], penguinRules));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-TITLE-PAGE-MISSING');
  });

  it('emits PRH-TITLE-PAGE-WRONG-STRUCTURE when .booktitle is missing', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/title.xhtml',
      content: penguinTitleVariant1().replace('class="booktitle"', 'class="generic_title"'),
    };
    const issues = validatePrhTitlePage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-WRONG-STRUCTURE')).toBeDefined();
  });

  it('emits PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO when the imprint_logo figure is absent', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/title.xhtml',
      content: penguinTitleVariant1().replace(/<figure class="imprint_logo">[\s\S]*?<\/figure>/, ''),
    };
    const issues = validatePrhTitlePage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO')).toBeDefined();
  });

  it('emits PRH-TITLE-PAGE-WRONG-LOGO-ALT when alt is "Penguin Books" instead of "Penguin Random House"', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/title.xhtml',
      content: penguinTitleVariant1().replace('alt="Penguin Random House"', 'alt="Penguin Books"'),
    };
    const issues = validatePrhTitlePage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-WRONG-LOGO-ALT')).toBeDefined();
  });
});

describe('validatePrhTitlePage — Puffin image-only', () => {
  const puffinRules = getImprintRules('puffin')!;

  it('emits zero issues for a compliant Puffin image-only title page', () => {
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title.xhtml', content: puffinImageOnlyTitlePage() };
    expect(validatePrhTitlePage(input([file], puffinRules))).toEqual([]);
  });

  it('emits PRH-TITLE-PAGE-WRONG-STRUCTURE when .image_full is missing', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/title.xhtml',
      content: puffinImageOnlyTitlePage().replace('class="image_full"', 'class="cover_image"'),
    };
    const issues = validatePrhTitlePage(input([file], puffinRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-WRONG-STRUCTURE')).toBeDefined();
  });

  it('does NOT emit imprint-logo issues for the image-only path', () => {
    // Puffin's full-bleed image carries the imprint mark; there's no
    // separate .imprint_logo figure to check.
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title.xhtml', content: puffinImageOnlyTitlePage() };
    const issues = validatePrhTitlePage(input([file], puffinRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO')).toBeUndefined();
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-WRONG-LOGO-ALT')).toBeUndefined();
  });
});

describe('validatePrhTitlePage — Pelican (imprint-specific alt)', () => {
  const pelicanRules = getImprintRules('pelican')!;

  it('passes when alt = "Pelican Books"', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/title.xhtml',
      content: penguinTitleVariant1().replace('alt="Penguin Random House"', 'alt="Pelican Books"'),
    };
    expect(validatePrhTitlePage(input([file], pelicanRules))).toEqual([]);
  });

  it('flags alt = "Penguin Random House" as wrong for Pelican', () => {
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title.xhtml', content: penguinTitleVariant1() };
    const issues = validatePrhTitlePage(input([file], pelicanRules));
    expect(issues.find((i) => i.code === 'PRH-TITLE-PAGE-WRONG-LOGO-ALT')).toBeDefined();
  });
});

describe('validatePrhTitlePage — imprints without a canonical title page', () => {
  it('Vintage emits zero title-page issues regardless of EPUB content', () => {
    const vintageRules = getImprintRules('vintage')!;
    expect(validatePrhTitlePage(input([], vintageRules))).toEqual([]);
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/title.xhtml', content: penguinTitleVariant1() };
    expect(validatePrhTitlePage(input([file], vintageRules))).toEqual([]);
  });

  it('Cornerstone Saga emits zero title-page issues regardless of EPUB content', () => {
    const sagaRules = getImprintRules('cornerstone-saga')!;
    expect(validatePrhTitlePage(input([], sagaRules))).toEqual([]);
  });
});
