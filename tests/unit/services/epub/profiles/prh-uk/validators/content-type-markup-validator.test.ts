import { describe, it, expect } from 'vitest';
import { validatePrhContentTypeMarkup } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/content-type-markup-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function file(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title><style>h1 { color: red; }</style></head>
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

describe('validatePrhContentTypeMarkup — PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING', () => {
  it('emits when a .sidebar_wrapper has no paired .maincontent_wrapper', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<div class="sidebar_wrapper"><p>aside</p></div>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(true);
  });

  it('does NOT emit when each sidebar has a maincontent sibling', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="sidebar_wrapper"><p>aside</p></div><div class="maincontent_wrapper"><p>main</p></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(false);
  });

  it('emits when sidebars outnumber maincontent wrappers', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="sidebar_wrapper"></div><div class="maincontent_wrapper"></div>' +
            '<div class="sidebar_wrapper"></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(true);
  });

  it('does NOT emit for books with no sidebars at all', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<p>Just a normal paragraph.</p>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(false);
  });

  it('does not false-match data-sidebar_wrapper attributes', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<div data-sidebar_wrapper="x"><p>not a sidebar</p></div>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(false);
  });

  it('emits when counts are equal but the sibling pairing is wrong', () => {
    // 2 sidebars + 2 maincontents — equal totals — but the first
    // sidebar is immediately followed by the SECOND sidebar, not by a
    // maincontent wrapper.
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="sidebar_wrapper"></div><div class="sidebar_wrapper"></div>' +
            '<div class="maincontent_wrapper"></div><div class="maincontent_wrapper"></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(true);
  });

  it('does NOT emit when each sidebar is immediately followed by its maincontent', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<section><div class="sidebar_wrapper"></div><div class="maincontent_wrapper"></div></section>' +
            '<section><div class="sidebar_wrapper"></div><div class="maincontent_wrapper"></div></section>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — PRH-MARKUP-TEXTBOX-USES-REAL-HEADER', () => {
  it('emits when the document first real header is inside a .txt_box', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<figure class="txt_box"><h2>Box title</h2><p>x</p></figure>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER')).toBe(true);
  });

  it('emits for txt_box variants (txt_box4, txt_box9b)', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<figure class="txt_box9b"><h3>Box</h3></figure>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER')).toBe(true);
  });

  it('does NOT emit when a real chapter header precedes the textbox', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<h1>Chapter One</h1><p>intro</p><figure class="txt_box"><h3>Box</h3></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER')).toBe(false);
  });

  it('does NOT emit when the textbox uses div.boxhead instead of a real header', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('ch1.xhtml', '<figure class="txt_box"><div class="boxhead">Box</div><p>x</p></figure>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — PRH-MARKUP-FLOATBOX-USES-REAL-HEADER', () => {
  it('emits when a .floatbox_left contains a real header', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('ch1.xhtml', '<h1>Chapter</h1><div class="floatbox_left"><h4>Float</h4></div>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER')).toBe(true);
  });

  it('emits when a .floatbox_right contains a real header', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<div class="floatbox_right"><h2>x</h2></div>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER')).toBe(true);
  });

  it('does NOT emit when the floatbox uses div.boxhead', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('ch1.xhtml', '<div class="floatbox_left"><div class="boxhead">Float</div></div>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER')).toBe(false);
  });

  it('handles nested div correctly (balanced matching)', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="floatbox_left"><div class="inner"><p>x</p></div></div><h1>After</h1>',
        ),
      ]),
    );
    // The <h1> is OUTSIDE the floatbox — balanced matching must not
    // swallow it into the floatbox region.
    expect(issues.some((i) => i.code === 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — PRH-MARKUP-POETRY-WRONG-STRUCTURE', () => {
  it('emits when a .poetry_stanza uses <p> for its lines', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<div class="poetry_stanza"><p>Line one</p><p>Line two</p></div>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-POETRY-WRONG-STRUCTURE')).toBe(true);
  });

  it('does NOT emit when the stanza uses div.poetry_line', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="poetry_stanza"><div class="poetry_line">Line one</div>' +
            '<div class="poetry_line_indented">Line two</div></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-POETRY-WRONG-STRUCTURE')).toBe(false);
  });

  it('does NOT emit for books with no poetry stanzas', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<p>Ordinary prose.</p>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-POETRY-WRONG-STRUCTURE')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS', () => {
  it('emits for a non-canonical speech-bubble class', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<figure class="speech_bubble"><p>Hi!</p></figure>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(true);
  });

  it('emits for speechbubble_left (close-but-not-canonical)', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<figure class="speechbubble_left"><p>Hi!</p></figure>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(true);
  });

  it('does NOT emit for canonical classes', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<figure class="speechbubble"></figure><figure class="speechbubble_r"></figure>' +
            '<figure class="speechbubble_bl"></figure><figure class="speechbubble_br"></figure>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(false);
  });

  it('does NOT emit for books with no speech bubbles', () => {
    const issues = validatePrhContentTypeMarkup(
      input([file('ch1.xhtml', '<p>No bubbles here.</p>')]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(false);
  });

  it('does NOT emit for a non-canonical speechbubble class inside an HTML comment', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('ch1.xhtml', '<!-- <figure class="speechbubble_alt"><p>draft</p></figure> -->'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(false);
  });

  it('does NOT emit for a speechbubble* class on a non-<figure> element', () => {
    // A CSS-helper class or wrapper div carrying a speechbubble-like
    // token must not trip the rule — PRH speech bubbles are always
    // <figure> elements.
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<div class="speechbubble_left"><figure class="speechbubble_r"><p>Hi</p></figure></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — PRH-MARKUP-METHOD-STEPS-NOT-OL', () => {
  it('emits a numbered <p> run when the book shows the cookbook signal', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        // Cookbook signal: 3 method_steps lists elsewhere in the book.
        file('recipe1.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe2.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe3.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        // The offending file: numbered <p> run instead of <ol>.
        file(
          'recipe4.xhtml',
          '<p>1. Preheat the oven.</p><p>2. Mix the dry ingredients.</p><p>3. Fold in the eggs.</p>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(true);
  });

  it('does NOT emit a numbered <p> run when there is NO cookbook signal', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        // No .method_steps anywhere — looks like a legal document, not a recipe book.
        file(
          'contract.xhtml',
          '<p>1. The party agrees to the terms.</p><p>2. The party waives all claims.</p>' +
            '<p>3. This contract is binding.</p>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(false);
  });

  it('does NOT emit for runs shorter than 3 numbered paragraphs', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('recipe1.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe2.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe3.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe4.xhtml', '<p>1. Only one numbered.</p><p>Plain follow-up paragraph.</p>'),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(false);
  });

  it('does NOT emit when numbered paragraphs are split across wrappers (not adjacent siblings)', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('recipe1.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe2.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe3.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        // Each numbered <p> is isolated in its own wrapper div — not a
        // contiguous run, so the adjacency guard resets between them.
        file(
          'recipe4.xhtml',
          '<div><p>1. First.</p></div><div><p>2. Second.</p></div><div><p>3. Third.</p></div>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(false);
  });

  it('does NOT let a commented-out method_steps reference flip the cookbook signal', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        // The only "method_steps" tokens are inside HTML comments — the
        // cookbook signal must stay off, so the numbered <p> run below
        // is treated as ordinary prose.
        file('a.xhtml', '<!-- <ol class="method_steps"></ol> -->'),
        file('b.xhtml', '<!-- <ol class="method_steps"></ol> -->'),
        file('c.xhtml', '<!-- <ol class="method_steps"></ol> -->'),
        file(
          'd.xhtml',
          '<p>1. First clause.</p><p>2. Second clause.</p><p>3. Third clause.</p>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(false);
  });

  it('resets the run on a non-numbered paragraph', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('recipe1.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe2.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        file('recipe3.xhtml', '<ol class="method_steps"><li>step</li></ol>'),
        // 2 numbered, plain break, 2 numbered — no run reaches 3.
        file(
          'recipe4.xhtml',
          '<p>1. First.</p><p>2. Second.</p><p>A note.</p><p>3. Third.</p><p>4. Fourth.</p>',
        ),
      ]),
    );
    expect(issues.some((i) => i.code === 'PRH-MARKUP-METHOD-STEPS-NOT-OL')).toBe(false);
  });
});

describe('validatePrhContentTypeMarkup — overall', () => {
  it('emits zero issues for a conformant book', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file(
          'ch1.xhtml',
          '<h1>Chapter One</h1><p>Prose.</p>' +
            '<div class="sidebar_wrapper"></div><div class="maincontent_wrapper"></div>' +
            '<figure class="txt_box"><div class="boxhead">Box</div></figure>' +
            '<div class="poetry_stanza"><div class="poetry_line">A line</div></div>' +
            '<figure class="speechbubble_r"><p>Hello</p></figure>',
        ),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('reports issues per file with the correct location', () => {
    const issues = validatePrhContentTypeMarkup(
      input([
        file('clean.xhtml', '<p>Nothing wrong here.</p>'),
        file('bad.xhtml', '<div class="poetry_stanza"><p>line</p></div>'),
      ]),
    );
    const poetryIssue = issues.find((i) => i.code === 'PRH-MARKUP-POETRY-WRONG-STRUCTURE');
    expect(poetryIssue?.location).toBe('bad.xhtml');
  });
});
