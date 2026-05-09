import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  aggregateConfidence,
  detectPublisherProfile,
} from '../../../../../src/services/epub/profiles/profile-detector.service';
import type { ProfileSignal } from '../../../../../src/services/epub/profiles/types';

/** Build an in-memory EPUB zip buffer for a given fixture set. */
async function buildEpub(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const PENGUIN_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Penguin Test</dc:title>
    <dc:publisher>Penguin Random House UK</dc:publisher>
  </metadata>
</package>`;

const NEUTRAL_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Independent Book</dc:title>
    <dc:publisher>Independent Press</dc:publisher>
  </metadata>
</package>`;

describe('detectPublisherProfile', () => {
  it('returns NO_PROFILE for an EPUB with no publisher signals', async () => {
    const buffer = await buildEpub({
      'EPUB/package.opf': NEUTRAL_OPF,
      'EPUB/xhtml/cover.xhtml': '<html><body><h1>Cover</h1></body></html>',
    });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBeNull();
    expect(profile.imprint).toBeNull();
    expect(profile.signals).toEqual([]);
  });

  it('detects PRH UK + penguin imprint at high confidence with multiple signals', async () => {
    const buffer = await buildEpub({
      'EPUB/package.opf': PENGUIN_OPF,
      'EPUB/prh_core_assets/images/prh_uk_logo.jpg': 'binary',
      'EPUB/images/penguin-cover.jpg': 'binary',
      'EPUB/Penguin/title.xhtml': '<html><body><h2>Author</h2></body></html>',
      'EPUB/xhtml/cover.xhtml': '<html><body>Cover</body></html>',
    });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBe('PRH-UK');
    expect(profile.imprint).toBe('penguin');
    expect(profile.confidence).toBe('high');
    expect(profile.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('returns medium confidence for a single strong signal', async () => {
    // prh_core_assets/ directory alone (no logo file inside) yields exactly
    // one strong signal and nothing else — confidence should land on medium.
    const buffer = await buildEpub({
      'EPUB/package.opf': NEUTRAL_OPF,
      'EPUB/prh_core_assets/styles/basestyles.css': 'body { }',
    });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBe('PRH-UK');
    expect(profile.confidence).toBe('medium');
  });

  it('returns NO_PROFILE when the zip is corrupt', async () => {
    const corrupt = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const profile = await detectPublisherProfile(corrupt);
    expect(profile.publisher).toBeNull();
    expect(profile.signals).toEqual([]);
  });

  it('parses container.xml with single-quoted full-path attribute', async () => {
    // Regression: XML allows either quote style; some authoring tools emit
    // single quotes. Detection must still succeed.
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path='EPUB/package.opf' media-type='application/oebps-package+xml'/>
  </rootfiles>
</container>`,
    );
    zip.file('EPUB/package.opf', PENGUIN_OPF);
    zip.file('EPUB/prh_core_assets/styles/basestyles.css', 'body { }');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBe('PRH-UK');
  });

  it('parses container.xml with whitespace around the = sign', async () => {
    // Regression: XML permits whitespace around attribute `=`. Detection
    // must still succeed.
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path = "EPUB/package.opf" media-type = "application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    );
    zip.file('EPUB/package.opf', PENGUIN_OPF);
    zip.file('EPUB/prh_core_assets/styles/basestyles.css', 'body { }');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBe('PRH-UK');
  });

  it('handles a missing OPF gracefully', async () => {
    // Build a zip with only the container.xml — no OPF file at the referenced path.
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="missing.opf"/></rootfiles></container>',
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const profile = await detectPublisherProfile(buffer);
    expect(profile.publisher).toBeNull();
  });
});

describe('aggregateConfidence', () => {
  const strong = (id: string): ProfileSignal => ({ id, description: id, strength: 'strong' });
  const moderate = (id: string): ProfileSignal => ({ id, description: id, strength: 'moderate' });
  const weak = (id: string): ProfileSignal => ({ id, description: id, strength: 'weak' });

  it('returns low for empty signals', () => {
    expect(aggregateConfidence([])).toBe('low');
  });

  it('returns low for a single weak signal', () => {
    expect(aggregateConfidence([weak('a')])).toBe('low');
  });

  it('returns low for a single moderate signal', () => {
    expect(aggregateConfidence([moderate('a')])).toBe('low');
  });

  it('returns medium for a single strong signal', () => {
    expect(aggregateConfidence([strong('a')])).toBe('medium');
  });

  it('returns medium for two moderate signals', () => {
    expect(aggregateConfidence([moderate('a'), moderate('b')])).toBe('medium');
  });

  it('returns high for a strong signal plus any second signal', () => {
    expect(aggregateConfidence([strong('a'), weak('b')])).toBe('high');
    expect(aggregateConfidence([strong('a'), moderate('b')])).toBe('high');
    expect(aggregateConfidence([strong('a'), strong('b')])).toBe('high');
  });
});
