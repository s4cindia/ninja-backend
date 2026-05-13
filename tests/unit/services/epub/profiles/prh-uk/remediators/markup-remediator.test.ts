import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import {
  fixDeprecatedTags,
  fixInlineStyles,
  fixEpubTypePlacement,
  addDocAriaRoles,
  fixBodyPurity,
  fixPagebreakMalformed,
} from '../../../../../../../src/services/epub/profiles/prh-uk/remediators/markup-remediator';

async function getFile(zip: JSZip, path: string): Promise<string> {
  const c = await zip.file(path)?.async('text');
  if (!c) throw new Error(`File not in zip: ${path}`);
  return c;
}

function buildXhtml(bodyInner: string, bodyAttrs: string = ''): string {
  return `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body ${bodyAttrs}>${bodyInner}</body>
</html>`;
}

describe('fixDeprecatedTags', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('swaps <b> → <strong>', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p><b>bold text</b></p>'));
    const result = await fixDeprecatedTags(zip);
    expect(result[0].success).toBe(true);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toContain('<strong>bold text</strong>');
    expect(updated).not.toContain('<b>');
  });

  it('swaps <i> → <em>', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p><i>italic</i></p>'));
    await fixDeprecatedTags(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toContain('<em>italic</em>');
  });

  it('strips <big>/<small>/<font>/<center> wrappers keeping inner text', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p><big>X</big> <small>Y</small> <font>Z</font> <center>W</center></p>'));
    await fixDeprecatedTags(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toContain('X');
    expect(updated).toContain('Y');
    expect(updated).toContain('Z');
    expect(updated).toContain('W');
    expect(updated).not.toMatch(/<big|<small|<font|<center/);
  });

  it('does NOT swap <u> (could be a real semantic underline)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p><u>underlined</u></p>'));
    const result = await fixDeprecatedTags(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toContain('<u>underlined</u>');
    expect(result[0].description).toMatch(/no deprecated|No changes needed/i);
  });

  it('does NOT false-match <body>/<br>/<blockquote> (tag-boundary regression)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<blockquote>x</blockquote><br/>'));
    const result = await fixDeprecatedTags(zip);
    expect(result[0].description).toMatch(/no deprecated/i);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toContain('<blockquote>');
    expect(updated).toContain('<br/>');
  });

  it('is idempotent — re-running on clean output produces no further changes', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p><b>x</b></p>'));
    await fixDeprecatedTags(zip);
    const result = await fixDeprecatedTags(zip);
    expect(result[0].description).toMatch(/no deprecated/i);
  });
});

describe('fixInlineStyles', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('strips style="…" attributes from body elements', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p style="color: red">red</p>'));
    await fixInlineStyles(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).not.toMatch(/style="/);
    expect(updated).toContain('<p>red</p>');
  });

  it('defers files with >50 inline styles (auto threshold)', async () => {
    const bigContent = Array(51).fill('<p style="margin: 1em">x</p>').join('');
    zip.file('big.xhtml', buildXhtml(bigContent));
    const result = await fixInlineStyles(zip);
    expect(result[0].description).toMatch(/deferred to operator review/i);
    // File NOT mutated — the 51 styles are still there.
    const after = await getFile(zip, 'big.xhtml');
    expect((after.match(/style="/g) || []).length).toBe(51);
  });

  it('does NOT false-match data-style attributes (regex-anchor regression)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p data-style="x">text</p>'));
    const result = await fixInlineStyles(zip);
    expect(result[0].description).toMatch(/no inline styles/i);
  });

  it('is idempotent', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p style="color: red">x</p>'));
    await fixInlineStyles(zip);
    const result = await fixInlineStyles(zip);
    expect(result[0].description).toMatch(/no inline styles/i);
  });
});

describe('fixEpubTypePlacement', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('swaps <section epub:type="chapter"> to <section role="doc-chapter">', async () => {
    zip.file('ch1.xhtml', buildXhtml('<section epub:type="chapter"><h1>Ch 1</h1></section>'));
    await fixEpubTypePlacement(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).not.toMatch(/epub:type\s*=\s*["']chapter/);
    expect(updated).toMatch(/role="doc-chapter"/);
  });

  it('swaps all forbidden values (part, dedication, epigraph, appendix)', async () => {
    zip.file('part.xhtml', buildXhtml('<section epub:type="part">Part 1</section>'));
    zip.file('dedication.xhtml', buildXhtml('<section epub:type="dedication">To X</section>'));
    zip.file('epigraph.xhtml', buildXhtml('<section epub:type="epigraph">Q</section>'));
    zip.file('appendix.xhtml', buildXhtml('<section epub:type="appendix">A1</section>'));
    await fixEpubTypePlacement(zip);
    expect(await getFile(zip, 'part.xhtml')).toMatch(/role="doc-part"/);
    expect(await getFile(zip, 'dedication.xhtml')).toMatch(/role="doc-dedication"/);
    expect(await getFile(zip, 'epigraph.xhtml')).toMatch(/role="doc-epigraph"/);
    expect(await getFile(zip, 'appendix.xhtml')).toMatch(/role="doc-appendix"/);
  });

  it('preserves an existing role attribute (doesn\'t double-set)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<section role="doc-chapter region" epub:type="chapter">x</section>'));
    await fixEpubTypePlacement(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    // Existing role preserved; epub:type stripped.
    expect(updated).toMatch(/role="doc-chapter region"/);
    expect(updated).not.toMatch(/epub:type/);
  });

  it('leaves <body epub:type="…"> alone (PRH allows it on body)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'epub:type="bodymatter"'));
    const result = await fixEpubTypePlacement(zip);
    expect(result[0].description).toMatch(/no misplaced/i);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/<body[^>]*epub:type="bodymatter"/);
  });

  it('is idempotent', async () => {
    zip.file('ch1.xhtml', buildXhtml('<section epub:type="chapter">x</section>'));
    await fixEpubTypePlacement(zip);
    const result = await fixEpubTypePlacement(zip);
    expect(result[0].description).toMatch(/no misplaced/i);
  });
});

describe('addDocAriaRoles', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('adds role="doc-chapter" to first chapter section when missing', async () => {
    zip.file('chapter1.xhtml', buildXhtml('<section><h1>C1</h1></section>'));
    await addDocAriaRoles(zip);
    const updated = await getFile(zip, 'chapter1.xhtml');
    expect(updated).toMatch(/<section[^>]*role="doc-chapter"/);
  });

  it('adds role="doc-epigraph" to first <blockquote> in epigraph.xhtml', async () => {
    zip.file('epigraph.xhtml', buildXhtml('<blockquote>"Quote"</blockquote>'));
    await addDocAriaRoles(zip);
    const updated = await getFile(zip, 'epigraph.xhtml');
    expect(updated).toMatch(/<blockquote[^>]*role="doc-epigraph"/);
  });

  it('does NOT touch a section that already has a role attribute', async () => {
    zip.file('chapter1.xhtml', buildXhtml('<section role="doc-chapter region"><h1>C1</h1></section>'));
    await addDocAriaRoles(zip);
    const updated = await getFile(zip, 'chapter1.xhtml');
    // Existing role preserved verbatim.
    expect(updated).toMatch(/role="doc-chapter region"/);
    expect((updated.match(/role=/g) || []).length).toBe(1);
  });

  it('is idempotent — second run on patched output is a no-op', async () => {
    zip.file('chapter1.xhtml', buildXhtml('<section><h1>C1</h1></section>'));
    await addDocAriaRoles(zip);
    const result = await addDocAriaRoles(zip);
    expect(result[0].description).toMatch(/no matching|no changes needed/i);
  });
});

describe('fixBodyPurity', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('strips role from <body>', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'role="main"'));
    await fixBodyPurity(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).not.toMatch(/<body[^>]*\srole=/);
  });

  it('strips multiple banned attributes at once', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'role="main" aria-label="Chapter" aria-labelledby="title"'));
    await fixBodyPurity(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).not.toMatch(/<body[^>]*role=/);
    expect(updated).not.toMatch(/<body[^>]*aria-label=/);
    expect(updated).not.toMatch(/<body[^>]*aria-labelledby=/);
  });

  it('preserves non-banned attributes (epub:type stays)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'epub:type="bodymatter" role="main"'));
    await fixBodyPurity(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/<body[^>]*epub:type="bodymatter"/);
    expect(updated).not.toMatch(/<body[^>]*role=/);
  });

  it('does NOT false-match data-role on body (anchor regression)', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'data-role="container" epub:type="bodymatter"'));
    const result = await fixBodyPurity(zip);
    expect(result[0].description).toMatch(/no <body> ARIA/i);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/data-role="container"/);
  });

  it('is idempotent', async () => {
    zip.file('ch1.xhtml', buildXhtml('<p>x</p>', 'role="main"'));
    await fixBodyPurity(zip);
    const result = await fixBodyPurity(zip);
    expect(result[0].description).toMatch(/no <body> ARIA/i);
  });
});

describe('fixPagebreakMalformed', () => {
  let zip: JSZip;
  beforeEach(() => { zip = new JSZip(); });

  it('adds role="doc-pagebreak" when missing', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span epub:type="pagebreak" aria-label="12"/>'));
    await fixPagebreakMalformed(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/role="doc-pagebreak"/);
  });

  it('appends doc-pagebreak to existing role attribute', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span epub:type="pagebreak" role="region" aria-label="12"/>'));
    await fixPagebreakMalformed(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/role="region doc-pagebreak"/);
  });

  it('rewrites aria-label="page 12" → aria-label="12"', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="page 12"/>'));
    await fixPagebreakMalformed(zip);
    const updated = await getFile(zip, 'ch1.xhtml');
    expect(updated).toMatch(/aria-label="12"/);
    expect(updated).not.toMatch(/aria-label="page 12"/);
  });

  it('leaves a correctly-shaped pagebreak alone', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span epub:type="pagebreak" role="doc-pagebreak" aria-label="42"/>'));
    const result = await fixPagebreakMalformed(zip);
    expect(result[0].description).toMatch(/no malformed/i);
  });

  it('is idempotent on patched output', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span epub:type="pagebreak" aria-label="page 1"/>'));
    await fixPagebreakMalformed(zip);
    const result = await fixPagebreakMalformed(zip);
    expect(result[0].description).toMatch(/no malformed/i);
  });

  it('does NOT touch spans without epub:type="pagebreak"', async () => {
    zip.file('ch1.xhtml', buildXhtml('<span>plain text</span>'));
    const result = await fixPagebreakMalformed(zip);
    expect(result[0].description).toMatch(/no malformed/i);
  });
});
