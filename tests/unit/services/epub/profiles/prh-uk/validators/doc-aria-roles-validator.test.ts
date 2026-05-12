import { describe, it, expect } from 'vitest';
import { validatePrhDocAriaRoles } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/doc-aria-roles-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function fileWith(path: string, inner: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body epub:type="bodymatter">${inner}</body>
</html>`,
  };
}

describe('validatePrhDocAriaRoles — chapter detection', () => {
  it('emits PRH-ARIA-CHAPTER-ROLE-MISSING when first chapter section lacks role="doc-chapter"', () => {
    const files = [
      fileWith('chapter1.xhtml', '<section><h1>Chapter 1</h1></section>'),
      fileWith('chapter2.xhtml', '<section><h1>Chapter 2</h1></section>'),
    ];
    const issues = validatePrhDocAriaRoles(input(files));
    const issue = issues.find((i) => i.code === 'PRH-ARIA-CHAPTER-ROLE-MISSING');
    expect(issue).toBeDefined();
    expect(issue?.location).toBe('chapter1.xhtml');
  });

  it('does NOT emit when chapter1.xhtml has role="doc-chapter"', () => {
    const files = [
      fileWith('chapter1.xhtml', '<section role="doc-chapter"><h1>Chapter 1</h1></section>'),
      fileWith('chapter2.xhtml', '<section><h1>Chapter 2</h1></section>'),
    ];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-CHAPTER-ROLE-MISSING')).toBeUndefined();
  });

  it('emits chapter issue AT MOST ONCE per EPUB (first-only rule)', () => {
    const files = [
      fileWith('chapter1.xhtml', '<section><h1>Chapter 1</h1></section>'),
      fileWith('chapter2.xhtml', '<section><h1>Chapter 2</h1></section>'),
      fileWith('chapter3.xhtml', '<section><h1>Chapter 3</h1></section>'),
    ];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.filter((i) => i.code === 'PRH-ARIA-CHAPTER-ROLE-MISSING')).toHaveLength(1);
  });

  it('SKIPS chapter check when only one chapter-shaped file exists (slim book guard)', () => {
    const files = [fileWith('chapter1.xhtml', '<section><h1>Chapter 1</h1></section>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-CHAPTER-ROLE-MISSING')).toBeUndefined();
  });

  it('SKIPS chapter check when no chapter-shaped files exist (essay / memoir)', () => {
    const files = [fileWith('content.xhtml', '<section><h1>Body</h1></section>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-CHAPTER-ROLE-MISSING')).toBeUndefined();
  });
});

describe('validatePrhDocAriaRoles — part / dedication / appendix detection', () => {
  it('emits PRH-ARIA-PART-ROLE-MISSING when part1.xhtml lacks role="doc-part"', () => {
    const files = [fileWith('part1.xhtml', '<section><h1>Part 1</h1></section>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-PART-ROLE-MISSING')).toBeDefined();
  });

  it('emits PRH-ARIA-DEDICATION-ROLE-MISSING when dedication.xhtml lacks role', () => {
    const files = [fileWith('dedication.xhtml', '<section>To my mother</section>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-DEDICATION-ROLE-MISSING')).toBeDefined();
  });

  it('emits PRH-ARIA-APPENDIX-ROLE-MISSING when appendix.xhtml lacks role', () => {
    const files = [fileWith('appendix.xhtml', '<section>Appendix A</section>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-APPENDIX-ROLE-MISSING')).toBeDefined();
  });

  it('does NOT emit when the role is correctly set on each section', () => {
    const files = [
      fileWith('part1.xhtml', '<section role="doc-part"><h1>Part 1</h1></section>'),
      fileWith('dedication.xhtml', '<section role="doc-dedication">To my mother</section>'),
      fileWith('appendix.xhtml', '<section role="doc-appendix">Appendix A</section>'),
    ];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues).toEqual([]);
  });
});

describe('validatePrhDocAriaRoles — epigraph (blockquote, not section)', () => {
  it('emits PRH-ARIA-EPIGRAPH-ROLE-MISSING when epigraph.xhtml blockquote lacks role', () => {
    const files = [fileWith('epigraph.xhtml', '<blockquote>“Quote.”</blockquote>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-EPIGRAPH-ROLE-MISSING')).toBeDefined();
  });

  it('does NOT emit when blockquote carries role="doc-epigraph"', () => {
    const files = [fileWith('epigraph.xhtml', '<blockquote role="doc-epigraph">“Quote.”</blockquote>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-EPIGRAPH-ROLE-MISSING')).toBeUndefined();
  });

  it('does NOT emit when epigraph.xhtml has no <blockquote> at all (different layout)', () => {
    // If the file doesn't contain the target element, the validator
    // can't enforce — emitting would be noise. Better to stay silent.
    const files = [fileWith('epigraph.xhtml', '<p>quote</p>')];
    const issues = validatePrhDocAriaRoles(input(files));
    expect(issues.find((i) => i.code === 'PRH-ARIA-EPIGRAPH-ROLE-MISSING')).toBeUndefined();
  });
});

describe('validatePrhDocAriaRoles — multi-value role attributes', () => {
  it('accepts role="doc-chapter region" (multi-value)', () => {
    const files = [
      fileWith('chapter1.xhtml', '<section role="doc-chapter region"><h1>C1</h1></section>'),
      fileWith('chapter2.xhtml', '<section role="doc-chapter region"><h1>C2</h1></section>'),
    ];
    expect(validatePrhDocAriaRoles(input(files))).toEqual([]);
  });
});
