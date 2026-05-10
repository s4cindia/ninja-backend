import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { fixDecorativeRole } from '../../../../../../../src/services/epub/profiles/prh-uk/remediators/image-remediator';

async function getFile(zip: JSZip, path: string): Promise<string> {
  const c = await zip.file(path)?.async('text');
  if (!c) throw new Error(`File not in zip: ${path}`);
  return c;
}

describe('fixDecorativeRole', () => {
  let zip: JSZip;
  beforeEach(() => {
    zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>`,
    );
    zip.file('EPUB/package.opf', '<?xml version="1.0"?><package/>');
  });

  it('adds role="presentation" to <img alt=""> without role', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html><body><img src="ornament.png" alt=""/></body></html>',
    );
    const results = await fixDecorativeRole(zip);
    expect(results[0].success).toBe(true);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/<img\b[^>]*\brole="presentation"/);
    expect(updated).toMatch(/<img\b[^>]*\balt=""/);
  });

  it('is a no-op when role="presentation" is already present', async () => {
    const original = '<?xml version="1.0"?><html><body><img src="ornament.png" alt="" role="presentation"/></body></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    const results = await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toBe(original);
    expect(results[0].description).toMatch(/already declares/i);
  });

  it('is a no-op when role="none" is present (ARIA-1.1 equivalent)', async () => {
    const original = '<?xml version="1.0"?><html><body><img src="ornament.png" alt="" role="none"/></body></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toBe(original);
  });

  it('does NOT touch images with non-empty alt', async () => {
    const original = '<?xml version="1.0"?><html><body><img src="photo.jpg" alt="A tree"/></body></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toBe(original);
  });

  it('does NOT touch images with no alt attribute (different concern)', async () => {
    const original = '<?xml version="1.0"?><html><body><img src="photo.jpg"/></body></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toBe(original);
  });

  it('emits one ChangeResult per touched file (per-file accounting)', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html><body><img src="a.png" alt=""/><img src="b.png" alt=""/></body></html>',
    );
    zip.file(
      'EPUB/xhtml/ch2.xhtml',
      '<?xml version="1.0"?><html><body><img src="c.png" alt=""/></body></html>',
    );
    zip.file(
      'EPUB/xhtml/ch3-already-ok.xhtml',
      '<?xml version="1.0"?><html><body><img src="d.png" alt="" role="presentation"/></body></html>',
    );
    const results = await fixDecorativeRole(zip);
    expect(results).toHaveLength(2);
    const descs = results.map((r) => r.description);
    // ch1 had 2 decorative images touched; ch2 had 1.
    expect(descs.some((d) => /2 decorative image\(s\) in EPUB\/xhtml\/ch1\.xhtml/.test(d))).toBe(true);
    expect(descs.some((d) => /1 decorative image\(s\) in EPUB\/xhtml\/ch2\.xhtml/.test(d))).toBe(true);
  });

  it('walks every XHTML/HTML file (.xhtml + .html + .htm)', async () => {
    zip.file('EPUB/xhtml/a.xhtml', '<html><body><img src="x" alt=""/></body></html>');
    zip.file('EPUB/xhtml/b.html', '<html><body><img src="y" alt=""/></body></html>');
    // Non-XHTML file should be ignored.
    zip.file('EPUB/styles/base.css', 'body{}');
    await fixDecorativeRole(zip);
    const a = await getFile(zip, 'EPUB/xhtml/a.xhtml');
    const b = await getFile(zip, 'EPUB/xhtml/b.html');
    expect(a).toMatch(/role="presentation"/);
    expect(b).toMatch(/role="presentation"/);
  });

  it('handles both quote styles', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      "<?xml version='1.0'?><html><body><img src='a.png' alt=''/></body></html>",
    );
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/role="presentation"/);
  });

  it('does NOT add role to img with a non-presentation role (regression: duplicate attribute)', async () => {
    // Regression for CodeRabbit Critical: previously the remediator only
    // skipped on role="presentation"/"none". An img with role="button"
    // would have got role="presentation" inserted, producing
    // `<img role="presentation" ... role="button">` — invalid XML.
    const original = '<?xml version="1.0"?><html><body><img src="ornament.png" alt="" role="button"/></body></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    // File must be byte-identical — no role attribute added.
    expect(updated).toBe(original);
    // Defensive: assert only one role attribute exists on the img.
    const roleMatches = updated.match(/<img\b[^>]*\brole\s*=/gi) || [];
    expect(roleMatches.length).toBe(1);
  });

  it('skips cover XHTML entirely (regression: PRH-COVER-ALT-EMPTY conflict)', async () => {
    // Regression for CodeRabbit P1: a cover with alt="" should NOT have
    // role="presentation" auto-applied — that would actively work
    // against the operator's intent to set a real alt text.
    const original = `<?xml version="1.0"?><html xmlns:epub="http://www.idpf.org/2007/ops">
  <body epub:type="cover"><img src="cover.jpg" alt=""/></body>
</html>`;
    zip.file('EPUB/xhtml/cover.xhtml', original);
    await fixDecorativeRole(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/cover.xhtml');
    expect(updated).toBe(original);
  });

  it('returns a no-op result when nothing in the zip needs fixing', async () => {
    zip.file('EPUB/xhtml/ch1.xhtml', '<html><body><img src="a.png" alt="" role="presentation"/></body></html>');
    const results = await fixDecorativeRole(zip);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].description).toMatch(/no change/i);
  });
});
