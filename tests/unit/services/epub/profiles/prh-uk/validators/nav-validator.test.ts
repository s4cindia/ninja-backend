import { describe, it, expect } from 'vitest';
import { validatePrhNav } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/nav-validator';

const COMPLIANT_NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      lang="en" xml:lang="en">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" role="doc-toc" aria-labelledby="toc_head" id="toc">
      <h2 id="toc_head">Contents</h2>
      <ol class="toc_ol_root">
        <li><a href="cover.xhtml">Cover</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks" class="at_only">
      <ol>
        <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
        <li><a epub:type="frontmatter ibooks:reader-start-page" href="title.xhtml">Frontmatter</a></li>
        <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>
        <li><a epub:type="bodymatter" href="title.xhtml">Begin Reading</a></li>
      </ol>
    </nav>
    <nav epub:type="page-list" role="doc-pagelist" aria-label="Print Page List"
         hidden="hidden" class="hidden_content">
      <ol>
        <li><a href="ch01.xhtml#page1">1</a></li>
      </ol>
    </nav>
  </body>
</html>`;

const INPUT = (navContent: string | null) => ({
  opfContent: '',
  opfPath: 'EPUB/package.opf',
  navContent,
  navPath: 'EPUB/nav.xhtml',
});

describe('validatePrhNav', () => {
  it('emits zero issues for a fully compliant nav doc', () => {
    expect(validatePrhNav(INPUT(COMPLIANT_NAV))).toEqual([]);
  });

  it('returns no issues when there is no nav doc (EPUBCheck handles that)', () => {
    expect(validatePrhNav(INPUT(null))).toEqual([]);
  });

  it('flags a missing page-list nav', () => {
    const nav = COMPLIANT_NAV.replace(
      /<nav epub:type="page-list"[\s\S]*?<\/nav>/,
      '',
    );
    const issues = validatePrhNav(INPUT(nav));
    expect(issues.find((i) => i.code === 'PRH-NAV-MISSING-PAGELIST')).toBeDefined();
  });

  it('flags a page-list nav hidden via inline style instead of the canonical attribute', () => {
    // Common authoring mistake: using inline style="display:none" instead of
    // the EPUB-canonical hidden="hidden" + class="hidden_content" pair.
    const nav = COMPLIANT_NAV.replace(
      'hidden="hidden" class="hidden_content"',
      'style="display: none"',
    );
    const issues = validatePrhNav(INPUT(nav));
    const issue = issues.find((i) => i.code === 'PRH-NAV-PAGELIST-NOT-HIDDEN');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/hidden="hidden"/);
    expect(issue?.message).toMatch(/hidden_content/);
  });

  it('flags missing hidden attribute alone (class present)', () => {
    const nav = COMPLIANT_NAV.replace('hidden="hidden" class="hidden_content"', 'class="hidden_content"');
    const issues = validatePrhNav(INPUT(nav));
    const issue = issues.find((i) => i.code === 'PRH-NAV-PAGELIST-NOT-HIDDEN');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/hidden="hidden"/);
  });

  it('flags missing class alone (hidden attribute present)', () => {
    const nav = COMPLIANT_NAV.replace('hidden="hidden" class="hidden_content"', 'hidden="hidden"');
    const issues = validatePrhNav(INPUT(nav));
    const issue = issues.find((i) => i.code === 'PRH-NAV-PAGELIST-NOT-HIDDEN');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/hidden_content/);
  });

  it('flags every missing landmark (cover/frontmatter/toc/bodymatter)', () => {
    // Strip the entire landmarks anchor list.
    const nav = COMPLIANT_NAV.replace(
      /<nav epub:type="landmarks"[\s\S]*?<\/nav>/,
      '<nav epub:type="landmarks" class="at_only"><ol></ol></nav>',
    );
    const issues = validatePrhNav(INPUT(nav));
    const codes = issues.map((i) => i.code).filter((c) => c.startsWith('PRH-NAV-LANDMARKS-')).sort();
    expect(codes).toEqual([
      'PRH-NAV-LANDMARKS-MISSING-BODYMATTER',
      'PRH-NAV-LANDMARKS-MISSING-COVER',
      'PRH-NAV-LANDMARKS-MISSING-FRONTMATTER',
      'PRH-NAV-LANDMARKS-MISSING-TOC',
    ]);
  });

  it('accepts a multi-token frontmatter epub:type ("frontmatter ibooks:reader-start-page")', () => {
    // PRH templates commonly add the iBooks start-page hint as a second
    // token. The validator must recognise the canonical frontmatter token
    // even when it isn't the only value.
    const issues = validatePrhNav(INPUT(COMPLIANT_NAV));
    expect(issues.find((i) => i.code === 'PRH-NAV-LANDMARKS-MISSING-FRONTMATTER')).toBeUndefined();
  });

  it('accepts attributes in either quote style', () => {
    const nav = COMPLIANT_NAV.replace(/"/g, "'");
    expect(validatePrhNav(INPUT(nav))).toEqual([]);
  });
});
