import { describe, it, expect } from 'vitest';
import { validatePrhInlineLang } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/inline-lang-validator';
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
<html xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

describe('validatePrhInlineLang — happy paths', () => {
  it('emits zero issues for plain English text', () => {
    const files = [file('<p>Plain English content with normal punctuation.</p>')];
    expect(validatePrhInlineLang(input(files))).toEqual([]);
  });

  it('does NOT fire on isolated non-Latin characters (<3 chars in a run)', () => {
    // Single ñ, é, or smart quotes are technically Latin-script but
    // even non-Latin singletons (one Cyrillic letter) shouldn't fire
    // because of the 3-char minimum.
    const files = [file('<p>Café résumé naïve — and one Я character.</p>')];
    expect(validatePrhInlineLang(input(files))).toEqual([]);
  });

  it('emits ZERO issues when foreign text is correctly wrapped in <span lang>', () => {
    // Russian phrase correctly marked → no issue.
    const files = [file('<p>The Russian for hello is <span lang="ru">привет</span>.</p>')];
    expect(validatePrhInlineLang(input(files))).toEqual([]);
  });
});

describe('validatePrhInlineLang — non-Latin run detection', () => {
  it('flags an unmarked Cyrillic run', () => {
    const files = [file('<p>The Russian for hello is привет — said the spy.</p>')];
    const issues = validatePrhInlineLang(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-LANG-INLINE-NOT-MARKED');
    expect(issues[0].message).toMatch(/привет/);
  });

  it('flags Devanagari runs (Hindi)', () => {
    const files = [file('<p>नमस्ते means hello.</p>')];
    expect(validatePrhInlineLang(input(files))).toHaveLength(1);
  });

  it('flags Arabic runs', () => {
    const files = [file('<p>The greeting مرحبا appears once.</p>')];
    expect(validatePrhInlineLang(input(files))).toHaveLength(1);
  });

  it('flags Han (CJK) runs', () => {
    const files = [file('<p>Beijing 北京 is the capital.</p>')];
    expect(validatePrhInlineLang(input(files))).toHaveLength(1);
  });

  it('aggregates multiple runs into ONE issue per file', () => {
    const files = [file('<p>привет and 北京 and नमस्ते all in one paragraph.</p>')];
    const issues = validatePrhInlineLang(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/3 unmarked/);
  });

  it('reports up to 3 sample runs in the message', () => {
    const files = [file('<p>привет здравствуйте добрый</p>')];
    const issues = validatePrhInlineLang(input(files));
    expect(issues[0].message).toMatch(/привет/);
  });
});

describe('validatePrhInlineLang — defensive paths', () => {
  it('handles files with no body content gracefully', () => {
    const files: PrhXhtmlFile[] = [{ path: 'empty.xhtml', content: '<html><body/></html>' }];
    expect(validatePrhInlineLang(input(files))).toEqual([]);
  });

  it('respects xml:lang too (a section with xml:lang="ru" is skipped)', () => {
    const files = [file('<section xml:lang="ru"><p>привет здравствуйте</p></section>')];
    expect(validatePrhInlineLang(input(files))).toEqual([]);
  });
});
