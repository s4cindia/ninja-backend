import { describe, it, expect } from 'vitest';
import { validatePrhBodyPurity } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/body-purity-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(path: string, bodyAttrs: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body ${bodyAttrs}>body</body>
</html>`,
  };
}

describe('validatePrhBodyPurity', () => {
  it('emits zero issues for a clean <body epub:type="bodymatter">', () => {
    const files = [file('ch1.xhtml', 'epub:type="bodymatter"')];
    expect(validatePrhBodyPurity(input(files))).toEqual([]);
  });

  it('emits PRH-BODY-HAS-ARIA when <body role="main">', () => {
    const files = [file('ch1.xhtml', 'role="main"')];
    const issues = validatePrhBodyPurity(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-BODY-HAS-ARIA');
    expect(issues[0].location).toBe('ch1.xhtml');
  });

  it('emits PRH-BODY-HAS-ARIA when <body aria-label="…">', () => {
    const files = [file('ch1.xhtml', 'aria-label="Chapter 1"')];
    const issues = validatePrhBodyPurity(input(files));
    expect(issues.find((i) => i.code === 'PRH-BODY-HAS-ARIA')).toBeDefined();
  });

  it('emits PRH-BODY-HAS-ARIA when <body aria-labelledby="…">', () => {
    const files = [file('ch1.xhtml', 'aria-labelledby="title"')];
    const issues = validatePrhBodyPurity(input(files));
    expect(issues.find((i) => i.code === 'PRH-BODY-HAS-ARIA')).toBeDefined();
  });

  it('lists ALL offending attributes in the message when multiple are present', () => {
    const files = [file('ch1.xhtml', 'role="main" aria-label="Chapter 1"')];
    const issues = validatePrhBodyPurity(input(files));
    expect(issues[0].message).toMatch(/role/);
    expect(issues[0].message).toMatch(/aria-label/);
  });

  it('does NOT false-match data-role (must be exact word boundary)', () => {
    const files = [file('ch1.xhtml', 'data-role="container"')];
    expect(validatePrhBodyPurity(input(files))).toEqual([]);
  });

  it('skips files with no <body> element (defensive — malformed input)', () => {
    const files: PrhXhtmlFile[] = [
      { path: 'broken.xhtml', content: '<html><head></head></html>' },
    ];
    expect(validatePrhBodyPurity(input(files))).toEqual([]);
  });

  it('emits one issue per offending file (not per attribute)', () => {
    const files = [
      file('a.xhtml', 'role="main" aria-label="A"'),
      file('b.xhtml', 'role="region"'),
      file('c.xhtml', 'epub:type="bodymatter"'),
    ];
    const issues = validatePrhBodyPurity(input(files));
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.location).sort()).toEqual(['a.xhtml', 'b.xhtml']);
  });
});
