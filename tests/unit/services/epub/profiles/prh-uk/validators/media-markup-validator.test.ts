import { describe, it, expect } from 'vitest';
import { validatePrhMediaMarkup } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/media-markup-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function file(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title><style>video { width: 100%; }</style></head>
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

describe('validatePrhMediaMarkup — PRH-MEDIA-WRAPPER-MISSING', () => {
  it('emits when a <video> is not inside a figure.media_wrapper', () => {
    const issues = validatePrhMediaMarkup(
      input([file('ch1.xhtml', '<video controls><source src="v.mp4"/>Fallback.</video>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(true);
  });

  it('emits when an <audio> is not inside a figure.media_wrapper', () => {
    const issues = validatePrhMediaMarkup(
      input([file('ch1.xhtml', '<audio controls><source src="a.mp3"/>Fallback.</audio>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(true);
  });

  it('does NOT emit when the media element IS inside figure.media_wrapper', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls><source src="v.mp4"/>Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(false);
  });

  it('does NOT emit when figure carries media_wrapper among other class tokens', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="full_bleed media_wrapper centered"><audio controls>Fallback.</audio></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(false);
  });

  it('emits when figure has the wrong class (not media_wrapper)', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file('ch1.xhtml', '<figure class="image_wrapper"><video controls>Fallback.</video></figure>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(true);
  });

  it('counts multiple unwrapped media elements in one file', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<video controls>A.</video><audio controls>B.</audio>',
        ),
      ]),
    );
    const wrapperIssue = issues.find((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING');
    expect(wrapperIssue?.message).toMatch(/2 element/);
  });

  it('does NOT emit for a book with no media elements', () => {
    const issues = validatePrhMediaMarkup(
      input([file('ch1.xhtml', '<p>Just prose, no media.</p>')]),
    );
    expect(issues).toEqual([]);
  });
});

describe('validatePrhMediaMarkup — PRH-MEDIA-FALLBACK-TEXT-MISSING', () => {
  it('emits when a <video> has only <source> children and no text', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls><source src="v.mp4"/></video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(true);
  });

  it('emits for a self-closing <video/> (no inner content at all)', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file('ch1.xhtml', '<figure class="media_wrapper"><video src="v.mp4" controls/></figure>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(true);
  });

  it('does NOT emit when the media element has fallback text', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls><source src="v.mp4"/>Your reader cannot play this video.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(false);
  });

  it('does NOT emit when fallback text is wrapped in a child element', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><audio controls><source src="a.mp3"/><p>Audio description here.</p></audio></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(false);
  });

  it('treats <track> children as non-fallback (still emits when only a track is present)', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls><source src="v.mp4"/><track kind="captions" src="c.vtt"/></video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(true);
  });
});

describe('validatePrhMediaMarkup — PRH-MEDIA-INLINE-WIDTH', () => {
  it('emits when a <video> sets a width attribute', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls width="640">Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-INLINE-WIDTH')).toBe(true);
  });

  it('emits when a <video> sets width via inline style', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls style="width: 80%;">Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-INLINE-WIDTH')).toBe(true);
  });

  it('does NOT emit when width is absent from the element', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls>Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-INLINE-WIDTH')).toBe(false);
  });

  it('does NOT false-match a data-width attribute', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls data-width="x">Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-INLINE-WIDTH')).toBe(false);
  });

  it('does NOT false-match max-width inside an inline style', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls style="max-width: 100%;">Fallback.</video></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-INLINE-WIDTH')).toBe(false);
  });
});

describe('validatePrhMediaMarkup — overall', () => {
  it('emits zero issues for a fully conformant media element', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="media_wrapper"><video controls><source src="v.mp4"/>This video shows the assembly process.</video></figure>',
        ),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('reports issues per file with the correct location', () => {
    const issues = validatePrhMediaMarkup(
      input([
        file('clean.xhtml', '<p>No media here.</p>'),
        file('bad.xhtml', '<video controls>x</video>'),
      ]),
    );
    const wrapperIssue = issues.find((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING');
    expect(wrapperIssue?.location).toBe('bad.xhtml');
  });

  it('does not scan media tags inside <head> (e.g. selectors in <style>)', () => {
    // The file() helper puts `video { width: 100% }` in a <style> block;
    // that must not be parsed as a media element.
    const issues = validatePrhMediaMarkup(
      input([file('ch1.xhtml', '<p>Prose only in the body.</p>')]),
    );
    expect(issues).toEqual([]);
  });

  it('ignores commented-out media markup (no false advisory failures)', () => {
    // A commented-out media element must not raise wrapper/fallback/width
    // failures — the reading system ignores comments and so should the
    // validator.
    const issues = validatePrhMediaMarkup(
      input([
        file('ch1.xhtml', '<!-- <video src="old.mp4" width="640">x</video> -->'),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('skips unbalanced media tags rather than emitting false fallback-missing', () => {
    // A <video> with no matching </video> is malformed — epubcheck flags
    // it. We must NOT pretend it's a self-closing element and emit a
    // PRH-MEDIA-FALLBACK-TEXT-MISSING for it.
    const issues = validatePrhMediaMarkup(
      input([file('ch1.xhtml', '<video controls src="v.mp4"><p>orphan')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MEDIA-FALLBACK-TEXT-MISSING')).toBe(false);
    expect(issues.some((i) => i.code === 'PRH-MEDIA-WRAPPER-MISSING')).toBe(false);
  });
});
