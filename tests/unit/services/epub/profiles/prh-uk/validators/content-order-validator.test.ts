import { describe, it, expect } from 'vitest';
import { validatePrhContentOrder } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/content-order-validator';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';
import type { ImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/_types';

/**
 * Build a minimal OPF with the listed spine entries. Each entry is
 * referenced by manifest id and matched to a same-name XHTML file. The
 * builder yields both the OPF string and an array of XHTML PrhXhtmlFile
 * objects with the supplied body epub:type attribute so the validator's
 * classifier exercises the canonical signal path.
 *
 * The `kindByIdref` map controls each entry's body epub:type, which
 * drives the spine-classifier under test (cover / titlepage /
 * copyright-page / biography / frontmatter / bodymatter / backmatter).
 * Use `kind === 'brand'` to emit an `id="brand_page"` body instead.
 * Use `kind === 'footnotes'` to emit `<section epub:type="footnotes">`.
 */
function buildEpub(
  entries: Array<{ id: string; href: string; kind: string; linear?: 'no' }>,
): { opf: string; xhtmlFiles: PrhXhtmlFile[] } {
  const manifestItems = entries.map((e) =>
    `<item id="${e.id}" href="${e.href}" media-type="application/xhtml+xml"${e.kind === 'cover-image' ? ' properties="cover-image"' : ''}/>`,
  ).join('\n');
  const spineItems = entries.map((e) =>
    `<itemref idref="${e.id}"${e.linear === 'no' ? ' linear="no"' : ''}/>`,
  ).join('\n');

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;

  const xhtmlFiles: PrhXhtmlFile[] = entries.map((e) => {
    const path = `EPUB/${e.href}`;
    return { path, content: xhtmlFor(e.kind) };
  });

  return { opf, xhtmlFiles };
}

function xhtmlFor(kind: string): string {
  const bodyAttrs = (() => {
    switch (kind) {
      case 'cover':
        return 'epub:type="cover"';
      case 'titlepage':
        return 'epub:type="frontmatter"';
      case 'copyright':
        return 'epub:type="frontmatter"';
      case 'brand':
        return 'epub:type="frontmatter" id="brand_page"';
      case 'biography':
        return 'epub:type="biography"';
      case 'bodymatter':
        return 'epub:type="bodymatter"';
      case 'backmatter':
        return 'epub:type="backmatter"';
      case 'footnotes':
        return 'epub:type="backmatter"';
      default:
        return '';
    }
  })();
  const inner = (() => {
    switch (kind) {
      case 'titlepage':
        return '<section epub:type="titlepage" class="titlepage"><h3 class="booktitle">T</h3></section>';
      case 'copyright':
        return '<section epub:type="copyright-page">Copyright</section>';
      case 'footnotes':
        return '<section epub:type="footnotes"><ol><li>fn</li></ol></section>';
      case 'brand':
        return '<figure class="brand_logo_solo"><img alt="Penguin Random House" /></figure>';
      default:
        return 'body';
    }
  })();
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body ${bodyAttrs}>${inner}</body>
</html>`;
}

function input(opf: string, xhtmlFiles: PrhXhtmlFile[], imprintRules: ImprintRules) {
  return {
    opfContent: opf,
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
    imprintRules,
  };
}

describe('validatePrhContentOrder — cover position', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits zero issues for a canonical spine: cover → title → copyright → brand → body → author bio', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    expect(validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules))).toEqual([]);
  });

  it('emits PRH-ORDER-COVER-NOT-FIRST when cover is at index 1', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-COVER-NOT-FIRST')).toBeDefined();
  });
});

describe('validatePrhContentOrder — brand-page presence', () => {
  it('emits PRH-ORDER-MISSING-BRAND-PAGE for Penguin when no brand page in spine', () => {
    const penguinRules = getImprintRules('penguin')!;
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-MISSING-BRAND-PAGE')).toBeDefined();
  });

  it('does NOT emit PRH-ORDER-MISSING-BRAND-PAGE for #Merky (no canonical brand page)', () => {
    const merkyRules = getImprintRules('merky')!;
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, merkyRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-MISSING-BRAND-PAGE')).toBeUndefined();
  });
});

describe('validatePrhContentOrder — copyright position', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits PRH-ORDER-COPYRIGHT-WRONG-POSITION when copyright sits AFTER bodymatter', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      // Copyright misplaced after bodymatter — wrong per PRH.
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-COPYRIGHT-WRONG-POSITION')).toBeDefined();
  });

  it('does NOT emit PRH-ORDER-COPYRIGHT-WRONG-POSITION when copyright is at end of frontmatter', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-COPYRIGHT-WRONG-POSITION')).toBeUndefined();
  });
});

describe('validatePrhContentOrder — footnotes ordering', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits PRH-ORDER-FOOTNOTES-NOT-LAST when footnotes sit mid-spine', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'fn', href: 'footnotes.xhtml', kind: 'footnotes', linear: 'no' },
      // Bodymatter AFTER footnotes — footnotes is not at the end.
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-FOOTNOTES-NOT-LAST')).toBeDefined();
  });

  it('does NOT emit PRH-ORDER-FOOTNOTES-NOT-LAST when footnotes are at the spine end', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'biography' },
      { id: 'fn', href: 'footnotes.xhtml', kind: 'footnotes', linear: 'no' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-FOOTNOTES-NOT-LAST')).toBeUndefined();
  });
});

describe('validatePrhContentOrder — about-the-author presence', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits PRH-ORDER-MISSING-ABOUT-AUTHOR when no biography entry exists', () => {
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-MISSING-ABOUT-AUTHOR')).toBeDefined();
  });

  it('detects About-the-Author via filename alone (no epub:type marker)', () => {
    // Some EPUBs ship an author bio without epub:type="biography" but
    // with a canonical filename — should still pass.
    const { opf, xhtmlFiles } = buildEpub([
      { id: 'cover', href: 'cover.xhtml', kind: 'cover', linear: 'no' },
      { id: 'title', href: 'title.xhtml', kind: 'titlepage' },
      { id: 'copyright', href: 'copyright.xhtml', kind: 'copyright' },
      { id: 'brand', href: 'brand_page.xhtml', kind: 'brand' },
      { id: 'body', href: 'chapter1.xhtml', kind: 'bodymatter' },
      { id: 'about', href: 'about_the_author.xhtml', kind: 'backmatter' },
    ]);
    const issues = validatePrhContentOrder(input(opf, xhtmlFiles, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-ORDER-MISSING-ABOUT-AUTHOR')).toBeUndefined();
  });
});

describe('validatePrhContentOrder — defensive paths', () => {
  it('returns [] when the OPF has no spine entries', () => {
    const penguinRules = getImprintRules('penguin')!;
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="x" href="x.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine></spine>
</package>`;
    expect(validatePrhContentOrder(input(opf, [], penguinRules))).toEqual([]);
  });

  it('returns [] when opfContent is empty', () => {
    const penguinRules = getImprintRules('penguin')!;
    expect(validatePrhContentOrder(input('', [], penguinRules))).toEqual([]);
  });
});
