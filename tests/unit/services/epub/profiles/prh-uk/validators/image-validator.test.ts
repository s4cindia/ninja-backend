import { describe, it, expect } from 'vitest';
import { validatePrhImages } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/image-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(opts: {
  files: PrhXhtmlFile[];
  bookTitle?: string | null;
  opfManifest?: string;
}) {
  return {
    opfContent: `<?xml version="1.0"?>
<package><metadata/><manifest>${opts.opfManifest ?? ''}</manifest><spine/></package>`,
    opfPath: 'EPUB/package.opf',
    bookTitle: opts.bookTitle === undefined ? 'My Book' : opts.bookTitle,
    xhtmlFiles: opts.files,
  };
}

const coverXhtmlWithAlt = (alt: string): string => `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Cover</title></head>
  <body epub:type="cover">
    <figure class="cover_image">
      <img src="../images/cover.jpg" alt="${alt}"/>
    </figure>
  </body>
</html>`;

describe('validatePrhImages — PRH-COVER-ALT-EMPTY', () => {
  it('passes when the cover img has non-empty alt', () => {
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: coverXhtmlWithAlt('Cover for My Book') }],
    }));
    expect(issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY')).toBeUndefined();
  });

  it('flags an empty alt on the cover img', () => {
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: coverXhtmlWithAlt('') }],
    }));
    const issue = issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('serious');
    expect(issue?.location).toBe('EPUB/xhtml/cover.xhtml');
    // Suggestion uses the book title when available.
    expect(issue?.suggestion).toMatch(/Cover for My Book/);
  });

  it('flags a cover image with no alt attribute at all', () => {
    const noAltCover = `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body epub:type="cover"><img src="../images/cover.jpg"/></body>
</html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: noAltCover }],
    }));
    const issue = issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/has no alt attribute/i);
  });

  it('falls back to a generic suggestion when bookTitle is null', () => {
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: coverXhtmlWithAlt('') }],
      bookTitle: null,
    }));
    const issue = issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY');
    expect(issue).toBeDefined();
    expect(issue?.suggestion).toMatch(/\[Book Title\]/);
  });

  it('locates the cover XHTML via manifest id="cover" when body has no epub:type', () => {
    // Some EPUBs put epub:type="cover" on a child instead of the body.
    const coverByManifestId = `<?xml version="1.0"?>
<html><body><img src="../images/cover.jpg" alt=""/></body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: coverByManifestId }],
      opfManifest: '<item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>',
    }));
    // Should locate cover via manifest id and flag the empty alt.
    expect(issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY')).toBeDefined();
  });

  it('does NOT flag a cover XHTML that contains no <img> (regression: SVG / background cover)', () => {
    // Regression for CodeRabbit Major: previously "no img" was treated
    // the same as "missing alt", producing a false-serious finding for
    // covers that use SVG or a background image.
    const svgCover = `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body epub:type="cover">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 150" role="doc-cover" aria-label="Cover for SVG Book"/>
  </body>
</html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: svgCover }],
    }));
    expect(issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY')).toBeUndefined();
  });

  it('does NOT emit PRH-COVER-ALT-EMPTY when no cover XHTML is found', () => {
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: '<html><body><img src="x.jpg" alt=""/></body></html>' }],
    }));
    expect(issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY')).toBeUndefined();
  });
});

describe('validatePrhImages — PRH-DECORATIVE-MISSING-PRESENTATION-ROLE', () => {
  it('emits one issue per decorative img missing role="presentation"', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="ornament.png" alt=""/>
      <img src="divider.png" alt=""/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    const roleIssues = issues.filter((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE');
    expect(roleIssues).toHaveLength(2);
    expect(roleIssues[0].location).toBe('EPUB/xhtml/ch1.xhtml');
    expect(roleIssues[0].message).toMatch(/ornament\.png/);
    expect(roleIssues[1].message).toMatch(/divider\.png/);
  });

  it('does NOT flag images with role="presentation"', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="ornament.png" alt="" role="presentation"/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });

  it('does NOT flag images with role="none" (ARIA-1.1 equivalent)', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="ornament.png" alt="" role="none"/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });

  it('does NOT flag images with non-empty alt (different issue class)', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="photo.jpg" alt="A photograph of a tree"/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });

  it('does NOT flag images with NO alt attribute (covered by EPUB-IMG-001)', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="photo.jpg"/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });

  it('scans every XHTML file in the input', () => {
    const issues = validatePrhImages(input({
      files: [
        { path: 'EPUB/xhtml/ch1.xhtml', content: '<html><body><img src="a.png" alt=""/></body></html>' },
        { path: 'EPUB/xhtml/ch2.xhtml', content: '<html><body><img src="b.png" alt=""/></body></html>' },
        { path: 'EPUB/xhtml/ch3.xhtml', content: '<html><body><img src="c.png" alt="" role="presentation"/></body></html>' },
      ],
    }));
    const roleIssues = issues.filter((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE');
    expect(roleIssues).toHaveLength(2);
    expect(roleIssues.map((i) => i.location).sort()).toEqual([
      'EPUB/xhtml/ch1.xhtml',
      'EPUB/xhtml/ch2.xhtml',
    ]);
  });

  it('accepts attributes in either quote style', () => {
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src='a.png' alt=''/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeDefined();
  });

  it('does NOT flag images with a non-presentation role like role="button" (regression)', () => {
    // Regression for CodeRabbit Critical: when an <img alt=""> already
    // carries a role (any role, not just presentation/none), the
    // validator should leave it alone — otherwise the auto-fix would
    // try to insert a second role attribute.
    const xhtml = `<?xml version="1.0"?><html><body>
      <img src="control.png" alt="" role="button"/>
    </body></html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/ch1.xhtml', content: xhtml }],
    }));
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });

  it('does NOT scan cover XHTML for decorative images (regression: P1 conflict)', () => {
    // Regression for CodeRabbit P1: previously a cover with alt="" on
    // its <img> emitted BOTH PRH-COVER-ALT-EMPTY (correct) and
    // PRH-DECORATIVE-MISSING-PRESENTATION-ROLE (incorrect — auto-fixing
    // the role would actively work against the cover-alt fix).
    const coverXhtml = `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body epub:type="cover"><img src="cover.jpg" alt=""/></body>
</html>`;
    const issues = validatePrhImages(input({
      files: [{ path: 'EPUB/xhtml/cover.xhtml', content: coverXhtml }],
    }));
    // Cover-alt issue SHOULD fire.
    expect(issues.find((i) => i.code === 'PRH-COVER-ALT-EMPTY')).toBeDefined();
    // Decorative-role issue must NOT fire for the cover.
    expect(issues.find((i) => i.code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE')).toBeUndefined();
  });
});
