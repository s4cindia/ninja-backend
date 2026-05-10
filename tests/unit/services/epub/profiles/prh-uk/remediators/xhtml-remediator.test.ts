import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { fixXmlLang } from '../../../../../../../src/services/epub/profiles/prh-uk/remediators/xhtml-remediator';

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

async function getFile(zip: JSZip, path: string): Promise<string> {
  const c = await zip.file(path)?.async('text');
  if (!c) throw new Error(`File not in zip: ${path}`);
  return c;
}

describe('fixXmlLang', () => {
  let zip: JSZip;
  beforeEach(() => {
    zip = new JSZip();
    zip.file('META-INF/container.xml', CONTAINER_XML);
    zip.file('EPUB/package.opf', '<?xml version="1.0"?><package/>');
  });

  it('adds both lang and xml:lang to <html> with neither attribute', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html><head><title>T</title></head><body/></html>',
    );
    const result = await fixXmlLang(zip);
    expect(result[0].success).toBe(true);
    expect(result[0].description).toMatch(/added/i);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/<html\b[^>]*\blang="en"/);
    expect(updated).toMatch(/<html\b[^>]*\bxml:lang="en"/);
  });

  it('adds only xml:lang when lang already present (the existing-handler gap)', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html lang="en"><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/<html\b[^>]*\blang="en"/);
    expect(updated).toMatch(/<html\b[^>]*\bxml:lang="en"/);
    // Verify no duplicate lang attribute was inserted.
    const langCount = (updated.match(/\blang\s*=/g) || []).length;
    expect(langCount).toBe(2); // 1 lang + 1 xml:lang
  });

  it('reuses existing lang code when adding xml:lang (no en hardcoding)', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html lang="fr"><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/xml:lang="fr"/);
    expect(updated).not.toMatch(/xml:lang="en"/);
  });

  it('reuses existing xml:lang code when adding lang', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html xml:lang="ja"><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/<html\b[^>]*\blang="ja"/);
  });

  it('is a no-op when both attributes are already present', async () => {
    const original = '<?xml version="1.0"?><html lang="en" xml:lang="en"><head><title>T</title></head><body/></html>';
    zip.file('EPUB/xhtml/ch1.xhtml', original);
    const result = await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toBe(original);
    expect(result[0].description).toMatch(/already carry/i);
  });

  it('walks every XHTML file in the zip', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html><body/></html>',
    );
    zip.file(
      'EPUB/xhtml/ch2.html',
      '<?xml version="1.0"?><html><body/></html>',
    );
    // Non-XHTML file should be ignored.
    zip.file('EPUB/styles/base.css', 'body {}');
    await fixXmlLang(zip);
    const ch1 = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    const ch2 = await getFile(zip, 'EPUB/xhtml/ch2.html');
    expect(ch1).toMatch(/lang="en"/);
    expect(ch2).toMatch(/lang="en"/);
  });

  it('replaces an empty lang="" with the default language (regression)', async () => {
    // Regression for CodeRabbit: empty lang="" was treated as "present"
    // so the remediator left it unchanged, leaving the file invalid.
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html lang=""><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/<html\b[^>]*\blang="en"/);
    expect(updated).toMatch(/<html\b[^>]*\bxml:lang="en"/);
    expect(updated).not.toMatch(/lang=""/);
  });

  it('replaces an empty xml:lang="" with the propagated language (regression)', async () => {
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html lang="fr" xml:lang=""><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/xml:lang="fr"/);
    expect(updated).not.toMatch(/xml:lang=""/);
  });

  it('emits one ChangeResult per touched file (per-file accounting)', async () => {
    // Regression for CodeRabbit major: per-file fixes need per-file
    // results so completion accounting can match tasks → files.
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html><head><title>T</title></head><body/></html>',
    );
    zip.file(
      'EPUB/xhtml/ch2.xhtml',
      '<?xml version="1.0"?><html><head><title>T</title></head><body/></html>',
    );
    zip.file(
      'EPUB/xhtml/ch3-already-ok.xhtml',
      '<?xml version="1.0"?><html lang="en" xml:lang="en"><head><title>T</title></head><body/></html>',
    );
    const results = await fixXmlLang(zip);
    // Two files touched → two results, each with the file path in the
    // description.
    expect(results).toHaveLength(2);
    const descriptions = results.map((r) => r.description).sort();
    expect(descriptions[0]).toMatch(/ch1\.xhtml/);
    expect(descriptions[1]).toMatch(/ch2\.xhtml/);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.before).toBeDefined();
      expect(r.after).toBeDefined();
    }
  });

  it('rejects an existing lang value containing illegal chars and falls back to default (regression)', async () => {
    // Regression for CodeRabbit: an attacker-crafted EPUB could carry
    // <html lang="<script>"> — though the regex rejects the quote char,
    // it still admits other XML-special characters. The remediator
    // must validate the token shape before re-injecting it into another
    // attribute, otherwise it will emit malformed XHTML.
    zip.file(
      'EPUB/xhtml/ch1.xhtml',
      '<?xml version="1.0"?><html lang="<weird>"><head><title>T</title></head><body/></html>',
    );
    await fixXmlLang(zip);
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    // The malformed value should be replaced with the default ("en"),
    // not propagated into xml:lang.
    expect(updated).toMatch(/lang="en"/);
    expect(updated).toMatch(/xml:lang="en"/);
    expect(updated).not.toMatch(/<weird>/);
  });

  it('falls back to "en" when defaultLanguage is empty/whitespace (regression)', async () => {
    // Regression for CodeRabbit: an empty or whitespace defaultLanguage
    // would have written `lang=""` / `xml:lang=""` — the same broken
    // attributes the validator complains about. Sanitise to "en".
    zip.file('EPUB/xhtml/ch1.xhtml', '<?xml version="1.0"?><html><body/></html>');
    await fixXmlLang(zip, '   ');
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/lang="en"/);
    expect(updated).toMatch(/xml:lang="en"/);
    expect(updated).not.toMatch(/lang=""/);
    expect(updated).not.toMatch(/lang="   "/);
  });

  it('uses a custom default language when supplied', async () => {
    zip.file('EPUB/xhtml/ch1.xhtml', '<?xml version="1.0"?><html><body/></html>');
    await fixXmlLang(zip, 'fr');
    const updated = await getFile(zip, 'EPUB/xhtml/ch1.xhtml');
    expect(updated).toMatch(/lang="fr"/);
    expect(updated).toMatch(/xml:lang="fr"/);
  });
});
