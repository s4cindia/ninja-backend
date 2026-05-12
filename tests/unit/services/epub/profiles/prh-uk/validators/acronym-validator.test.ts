import { describe, it, expect } from 'vitest';
import { validatePrhAcronyms } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/acronym-validator';
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

describe('validatePrhAcronyms — flagged cases (3+ letters with separators)', () => {
  it('flags "N.A.S.A."', () => {
    const files = [file('<p>The N.A.S.A. mission launched.</p>')];
    const issues = validatePrhAcronyms(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-ACRONYM-INSERTED-SEPARATORS');
    expect(issues[0].message).toMatch(/N\.A\.S\.A/);
  });

  it('flags "F.B.I."', () => {
    const files = [file('<p>An F.B.I. agent arrived.</p>')];
    expect(validatePrhAcronyms(input(files))).toHaveLength(1);
  });

  it('flags space-separated 3-letter acronym ("U S A")', () => {
    const files = [file('<p>Born in the U S A according to the song.</p>')];
    const issues = validatePrhAcronyms(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/U S A/);
  });

  it('flags comma-separated 3-letter acronym ("F, B, I")', () => {
    const files = [file('<p>Agency: F, B, I — the bureau.</p>')];
    const issues = validatePrhAcronyms(input(files))[0];
    expect(issues.message).toMatch(/F, B, I/);
  });

  it('flags 4+ letter acronyms ("R.S.V.P.")', () => {
    const files = [file('<p>R.S.V.P. requested.</p>')];
    expect(validatePrhAcronyms(input(files))).toHaveLength(1);
  });
});

describe('validatePrhAcronyms — NOT flagged (intentional exclusions)', () => {
  it('does NOT flag 2-letter abbreviations ("U.S.", "J.K.")', () => {
    // Two-letter sequences are routine in body text and rarely cause
    // TTS problems. Style Guide tolerates them.
    const files = [file('<p>The U.S. economy. J.K. Rowling wrote it.</p>')];
    expect(validatePrhAcronyms(input(files))).toEqual([]);
  });

  it('does NOT flag compact acronyms ("NASA", "FBI", "USA")', () => {
    const files = [file('<p>NASA, the FBI, and the USA work together.</p>')];
    expect(validatePrhAcronyms(input(files))).toEqual([]);
  });

  it('does NOT flag "e.g." or "i.e." (lowercase, not all-caps)', () => {
    const files = [file('<p>The pattern, e.g., NASA, is compact. See also i.e.</p>')];
    expect(validatePrhAcronyms(input(files))).toEqual([]);
  });

  it('does NOT flag mixed-case words like "PhD"', () => {
    const files = [file('<p>She holds a PhD in mathematics.</p>')];
    expect(validatePrhAcronyms(input(files))).toEqual([]);
  });
});

describe('validatePrhAcronyms — message shape', () => {
  it('lists multiple unique offenders', () => {
    const files = [file('<p>N.A.S.A. and F.B.I. and U S A.</p>')];
    const issues = validatePrhAcronyms(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/3 acronym/);
  });

  it('de-duplicates repeated offenders', () => {
    const files = [file('<p>N.A.S.A. and N.A.S.A. again and once more N.A.S.A.</p>')];
    const issues = validatePrhAcronyms(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/1 acronym/);
  });

  it('emits ONE issue per offending file', () => {
    const files = [
      file('<p>N.A.S.A.</p>'),
      { path: 'b.xhtml', content: '<html><body><p>F.B.I.</p></body></html>' },
      { path: 'c.xhtml', content: '<html><body><p>clean</p></body></html>' },
    ];
    const issues = validatePrhAcronyms(input(files));
    expect(issues).toHaveLength(2);
  });
});
