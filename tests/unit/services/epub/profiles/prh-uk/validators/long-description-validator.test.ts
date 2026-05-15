import { describe, it, expect } from 'vitest';
import { validatePrhLongDescriptionInline } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/long-description-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function file(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

function input(files: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles: files,
  };
}

/** Build a paragraph of plain text exactly `n` characters long. */
function textOfLength(n: number): string {
  return 'x'.repeat(n);
}

describe('validatePrhLongDescriptionInline — PRH-FIGURE-LONG-DESC-INLINE', () => {
  it('emits when a <figcaption> contains 250+ chars of text', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="x.png"/><figcaption>${textOfLength(300)}</figcaption></figure>`,
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-FIGURE-LONG-DESC-INLINE')).toBe(true);
  });

  it('emits at exactly 250 chars (threshold is inclusive)', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="x.png"/><figcaption>${textOfLength(250)}</figcaption></figure>`,
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-FIGURE-LONG-DESC-INLINE')).toBe(true);
  });

  it('does NOT emit for short captions (under threshold)', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          '<figure><img src="x.png"/><figcaption>Fig. 3. The Eiffel Tower, 1889.</figcaption></figure>',
        ),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('counts only text content, ignoring child tags', () => {
    // 240 visible chars wrapped in <p>/<span> — still under threshold.
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="x.png"/><figcaption><p><span>${textOfLength(240)}</span></p></figcaption></figure>`,
        ),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('measures combined text across child tags', () => {
    // Two 130-char spans = 260 visible chars (above threshold).
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="x.png"/><figcaption><p>${textOfLength(130)}</p><p>${textOfLength(130)}</p></figcaption></figure>`,
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-FIGURE-LONG-DESC-INLINE')).toBe(true);
  });

  it('counts multiple long figcaptions in one file', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="a.png"/><figcaption>${textOfLength(300)}</figcaption></figure>` +
            `<figure><img src="b.png"/><figcaption>${textOfLength(400)}</figcaption></figure>`,
        ),
      ]),
    );
    const longDescIssue = issues.find((i) => i.code === 'PRH-FIGURE-LONG-DESC-INLINE');
    expect(longDescIssue?.message).toMatch(/2 figcaption/);
  });

  it('does NOT count a short and a long caption together — only the long one fires', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="a.png"/><figcaption>Short caption.</figcaption></figure>` +
            `<figure><img src="b.png"/><figcaption>${textOfLength(300)}</figcaption></figure>`,
        ),
      ]),
    );
    const longDescIssue = issues.find((i) => i.code === 'PRH-FIGURE-LONG-DESC-INLINE');
    expect(longDescIssue?.message).toMatch(/1 figcaption/);
  });

  it('does NOT emit for a book with no <figcaption> at all', () => {
    const issues = validatePrhLongDescriptionInline(
      input([file('ch1.xhtml', '<p>Just prose.</p>')]),
    );
    expect(issues).toEqual([]);
  });

  it('normalises whitespace before measuring (newlines + indentation do not inflate length)', () => {
    // ~240 visible chars but with newlines + indentation pushing raw
    // length above 250. Must measure post-normalisation.
    const padded = '   ' + textOfLength(240).replace(/(.{40})/g, '$1\n    ') + '   ';
    const issues = validatePrhLongDescriptionInline(
      input([
        file(
          'ch1.xhtml',
          `<figure><img src="x.png"/><figcaption>${padded}</figcaption></figure>`,
        ),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('ignores a commented-out figcaption', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file('ch1.xhtml', `<!-- <figcaption>${textOfLength(300)}</figcaption> -->`),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('reports the correct file location across multiple files', () => {
    const issues = validatePrhLongDescriptionInline(
      input([
        file('clean.xhtml', '<p>nothing.</p>'),
        file(
          'long.xhtml',
          `<figure><img src="x.png"/><figcaption>${textOfLength(300)}</figcaption></figure>`,
        ),
      ]),
    );
    expect(issues.length).toBe(1);
    expect(issues[0].location).toBe('long.xhtml');
  });

  it('skips unbalanced <figcaption> rather than emit on garbage', () => {
    const issues = validatePrhLongDescriptionInline(
      input([file('ch1.xhtml', `<figcaption>${textOfLength(300)}<p>orphan`)]),
    );
    expect(issues).toEqual([]);
  });
});
