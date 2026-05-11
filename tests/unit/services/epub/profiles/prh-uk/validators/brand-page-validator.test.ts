import { describe, it, expect } from 'vitest';
import { validatePrhBrandPage } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/brand-page-validator';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';
import type { ImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/_types';

function compliantPenguinBrandPage(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Brand</title></head>
<body epub:type="frontmatter" id="brand_page">
  <figure class="brand_logo_solo">
    <img src="Penguin/images/logo_large.png" alt="Penguin Random House" />
  </figure>
</body>
</html>`;
}

function compliantVintageBrandPage(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Vintage</title></head>
<body epub:type="frontmatter" id="brand_page">
  <figure class="image_full">
    <img src="vintage/images/logo_large.png" alt="Vintage Books" />
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

describe('validatePrhBrandPage — Penguin (.brand_logo_solo)', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits zero issues for a fully compliant Penguin brand page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage(),
    };
    expect(validatePrhBrandPage(input([file], penguinRules))).toEqual([]);
  });

  it('emits PRH-BRAND-PAGE-MISSING when no brand page exists in the EPUB', () => {
    const issues = validatePrhBrandPage(input([], penguinRules));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-BRAND-PAGE-MISSING');
  });

  it('emits PRH-BRAND-PAGE-WRONG-CLASS when the figure uses .image_full (Vintage class) on Penguin', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage().replace('brand_logo_solo', 'image_full'),
    };
    const issues = validatePrhBrandPage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-CLASS')).toBeDefined();
  });

  it('emits PRH-BRAND-PAGE-WRONG-LOGO-ALT when alt is "Penguin Books" instead of "Penguin Random House"', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage().replace('alt="Penguin Random House"', 'alt="Penguin Books"'),
    };
    const issues = validatePrhBrandPage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-LOGO-ALT')).toBeDefined();
  });

  it('emits PRH-BRAND-PAGE-WRONG-LOGO-ALT when alt is empty', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage().replace('alt="Penguin Random House"', 'alt=""'),
    };
    const issues = validatePrhBrandPage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-LOGO-ALT')).toBeDefined();
  });

  it('passes when alt is in a different case ("PENGUIN RANDOM HOUSE")', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage().replace('alt="Penguin Random House"', 'alt="PENGUIN RANDOM HOUSE"'),
    };
    const issues = validatePrhBrandPage(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-LOGO-ALT')).toBeUndefined();
  });

  it('finds the brand page via filename heuristic when epub:type is missing', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand_page.xhtml',
      content: compliantPenguinBrandPage().replace(/<body[^>]*>/, '<body>'),
    };
    expect(validatePrhBrandPage(input([file], penguinRules))).toEqual([]);
  });
});

describe('validatePrhBrandPage — Vintage (.image_full)', () => {
  const vintageRules = getImprintRules('vintage')!;

  it('emits zero issues for a fully compliant Vintage brand page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage_brand.xhtml',
      content: compliantVintageBrandPage(),
    };
    expect(validatePrhBrandPage(input([file], vintageRules))).toEqual([]);
  });

  it('emits PRH-BRAND-PAGE-WRONG-CLASS when Vintage uses .brand_logo_solo (Penguin class)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage_brand.xhtml',
      content: compliantVintageBrandPage().replace('image_full', 'brand_logo_solo'),
    };
    const issues = validatePrhBrandPage(input([file], vintageRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-CLASS')).toBeDefined();
  });

  it('emits PRH-BRAND-PAGE-WRONG-LOGO-ALT when alt says "Vintage" not "Vintage Books"', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage_brand.xhtml',
      content: compliantVintageBrandPage().replace('alt="Vintage Books"', 'alt="Vintage"'),
    };
    const issues = validatePrhBrandPage(input([file], vintageRules));
    expect(issues.find((i) => i.code === 'PRH-BRAND-PAGE-WRONG-LOGO-ALT')).toBeDefined();
  });
});

describe('validatePrhBrandPage — imprints without a canonical brand page', () => {
  it('#Merky emits zero brand-page issues regardless of EPUB content', () => {
    const merkyRules = getImprintRules('merky')!;
    expect(validatePrhBrandPage(input([], merkyRules))).toEqual([]);
    // Even when a brand page IS present, #Merky has no rules → no issues.
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/brand.xhtml',
      content: compliantPenguinBrandPage(),
    };
    expect(validatePrhBrandPage(input([file], merkyRules))).toEqual([]);
  });

  it('Cornerstone Saga emits zero brand-page issues regardless of EPUB content', () => {
    const sagaRules = getImprintRules('cornerstone-saga')!;
    expect(validatePrhBrandPage(input([], sagaRules))).toEqual([]);
  });
});
