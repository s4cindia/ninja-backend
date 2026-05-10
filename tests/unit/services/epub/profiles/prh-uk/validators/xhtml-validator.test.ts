import { describe, it, expect } from 'vitest';
import { validatePrhPerXhtml } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/xhtml-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(files: PrhXhtmlFile[], bookTitle: string | null = 'My Book') {
  return {
    opfContent: '',
    opfPath: 'EPUB/package.opf',
    bookTitle,
    xhtmlFiles: files,
  };
}

const compliantPage = (titleText: string): string => `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
  <head><title>${titleText}</title></head>
  <body><p>Hello</p></body>
</html>`;

describe('validatePrhPerXhtml', () => {
  it('emits zero issues for a compliant XHTML file', () => {
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: compliantPage('Chapter 1, My Book') },
    ]));
    expect(issues).toEqual([]);
  });

  it('flags <html> missing both lang and xml:lang', () => {
    const html = compliantPage('Chapter 1').replace(
      'lang="en" xml:lang="en"',
      '',
    );
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]));
    const issue = issues.find((i) => i.code === 'PRH-XHTML-XML-LANG');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/lang/);
    expect(issue?.message).toMatch(/xml:lang/);
  });

  it('flags <html> with lang but no xml:lang (the EPUB-SEM-001 gap)', () => {
    const html = compliantPage('Chapter 1').replace(
      'lang="en" xml:lang="en"',
      'lang="en"',
    );
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]));
    const issue = issues.find((i) => i.code === 'PRH-XHTML-XML-LANG');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/xml:lang/);
    expect(issue?.message).not.toMatch(/\blang\b,/);  // 'lang' alone shouldn't be in reasons list
  });

  it('flags <html> with xml:lang but no lang', () => {
    const html = compliantPage('Chapter 1').replace(
      'lang="en" xml:lang="en"',
      'xml:lang="en"',
    );
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]));
    const issue = issues.find((i) => i.code === 'PRH-XHTML-XML-LANG');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/^.*missing[^:]*:.*\blang\b/);
  });

  it('flags an empty <head><title>', () => {
    const html = compliantPage('').replace('<title></title>', '<title></title>');
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]));
    expect(issues.find((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC')).toBeDefined();
  });

  it('flags a missing <title> tag entirely', () => {
    const html = compliantPage('x').replace(/<title>.*<\/title>/, '');
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]));
    expect(issues.find((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC')).toBeDefined();
  });

  it('flags <title> that equals the book title (no chapter/section identifier)', () => {
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: compliantPage('My Book') },
    ]));
    const issue = issues.find((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/just the book title/i);
  });

  it('does NOT flag <title> when there is no book title to compare against', () => {
    // bookTitle null → skip the equality check, only flag empty/missing.
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: compliantPage('Section') },
    ], null));
    expect(issues.find((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC')).toBeUndefined();
  });

  it('compares <title> to book title case-insensitively', () => {
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: compliantPage('MY BOOK') },
    ], 'My Book'));
    expect(issues.find((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC')).toBeDefined();
  });

  it('emits one issue per offending file (granular reporting)', () => {
    const issues = validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: compliantPage('Chapter 1, My Book') },
      { path: 'EPUB/xhtml/ch2.xhtml', content: compliantPage('My Book') },
      { path: 'EPUB/xhtml/ch3.xhtml', content: compliantPage('My Book') },
    ]));
    const titleIssues = issues.filter((i) => i.code === 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC');
    expect(titleIssues).toHaveLength(2);
    expect(titleIssues.map((i) => i.location).sort()).toEqual([
      'EPUB/xhtml/ch2.xhtml',
      'EPUB/xhtml/ch3.xhtml',
    ]);
  });

  it('handles attributes in either quote style', () => {
    const html = compliantPage('Chapter 1, My Book').replace(/"/g, "'");
    expect(validatePrhPerXhtml(input([
      { path: 'EPUB/xhtml/ch1.xhtml', content: html },
    ]))).toEqual([]);
  });
});
