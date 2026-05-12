import { describe, it, expect } from 'vitest';
import { validatePrhHashtags } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/hashtag-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(body: string): PrhXhtmlFile {
  return {
    path: 'chapter1.xhtml',
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

describe('validatePrhHashtags — happy paths', () => {
  it('emits zero issues for properly camelCased hashtags', () => {
    const files = [file('<p>Follow #WomenInTech and #nytBestseller for updates.</p>')];
    expect(validatePrhHashtags(input(files))).toEqual([]);
  });

  it('accepts PascalCase tokens', () => {
    const files = [file('<p>#WomenInTech</p>')];
    expect(validatePrhHashtags(input(files))).toEqual([]);
  });

  it('accepts camelCase tokens with internal capital', () => {
    const files = [file('<p>#nytBestseller</p>')];
    expect(validatePrhHashtags(input(files))).toEqual([]);
  });

  it('accepts mixed-case acronym-style tokens', () => {
    const files = [file('<p>#PRHuk</p>')];
    expect(validatePrhHashtags(input(files))).toEqual([]);
  });

  it('does NOT flag numeric tokens like "#42" or "#1"', () => {
    const files = [file('<p>see #42 in the index</p>')];
    expect(validatePrhHashtags(input(files))).toEqual([]);
  });
});

describe('validatePrhHashtags — non-camel detection', () => {
  it('flags all-lowercase hashtags', () => {
    const files = [file('<p>Follow #womenintech for more.</p>')];
    const issues = validatePrhHashtags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-HASHTAG-NOT-CAMEL-CASE');
    expect(issues[0].message).toMatch(/#womenintech/);
  });

  it('flags all-uppercase hashtags', () => {
    const files = [file('<p>#NYTBESTSELLER</p>')];
    const issues = validatePrhHashtags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/#NYTBESTSELLER/);
  });

  it('de-duplicates repeated offenders in the message count', () => {
    const files = [file('<p>#womenintech and again #womenintech and more #womenintech</p>')];
    const issues = validatePrhHashtags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/1 unique non-camelCase hashtag/);
  });

  it('lists multiple unique offenders', () => {
    const files = [file('<p>#womenintech #nytbestseller #BOOKTOK</p>')];
    const issues = validatePrhHashtags(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/3 unique non-camelCase/);
  });

  it('emits ONE issue per offending file', () => {
    const files = [
      file('<p>#allnouns</p>'),
      { path: 'b.xhtml', content: '<html><body><p>#alsoalllowercase</p></body></html>' },
      { path: 'c.xhtml', content: '<html><body><p>clean</p></body></html>' },
    ];
    const issues = validatePrhHashtags(input(files));
    expect(issues).toHaveLength(2);
  });
});
