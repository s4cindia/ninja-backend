import { describe, it, expect } from 'vitest';
import { detectPrhImprint } from '../../../../../../src/services/epub/profiles/prh-uk/imprint-detector';

const PRH_PUBLISHER_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:publisher>Penguin Random House UK</dc:publisher>
    <dc:title>Test Book</dc:title>
  </metadata>
</package>`;

describe('detectPrhImprint', () => {
  it('returns no PRH signals for a non-PRH EPUB', () => {
    const result = detectPrhImprint({
      opfContent: '<?xml version="1.0"?><package><metadata><dc:title>Random Book</dc:title></metadata></package>',
      filePaths: ['EPUB/xhtml/cover.xhtml', 'EPUB/xhtml/chapter001.xhtml'],
      contentSample: '<p>Just regular content with no publisher hints.</p>',
    });
    expect(result.isPrhUk).toBe(false);
    expect(result.imprint).toBeNull();
    expect(result.signals).toEqual([]);
  });

  it('detects PRH UK from a dc:publisher field alone', () => {
    const result = detectPrhImprint({
      opfContent: PRH_PUBLISHER_OPF,
      filePaths: ['EPUB/xhtml/cover.xhtml'],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.signals.find((s) => s.id === 'publisher-text-opf')).toBeDefined();
    // Publisher matched but no imprint pinned → 'unknown'
    expect(result.imprint).toBe('unknown');
  });

  it('treats a prh_core_assets/ path as a strong signal', () => {
    const result = detectPrhImprint({
      opfContent: '',
      filePaths: ['EPUB/prh_core_assets/images/prh_uk_logo.jpg', 'EPUB/xhtml/cover.xhtml'],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.signals.find((s) => s.id === 'prh-core-assets-path')).toBeDefined();
  });

  it('detects Penguin imprint via cover-asset filename', () => {
    const result = detectPrhImprint({
      opfContent: PRH_PUBLISHER_OPF,
      filePaths: ['EPUB/images/penguin-cover.jpg', 'EPUB/Penguin/title.xhtml'],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('penguin');
  });

  it('detects Puffin imprint via puffin/ path', () => {
    const result = detectPrhImprint({
      opfContent: PRH_PUBLISHER_OPF,
      filePaths: ['EPUB/Puffin/title.xhtml', 'EPUB/images/puffin_logo.png'],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('puffin');
  });

  it('detects Vintage imprint from text + URL combined', () => {
    const result = detectPrhImprint({
      opfContent: '<dc:publisher>Vintage Books</dc:publisher>',
      filePaths: ['EPUB/vintage/copyright.xhtml'],
      contentSample: 'Read Boldly. Visit penguin.co.uk/vintage for more.',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('vintage');
  });

  it('detects Cornerstone Saga via Penny Street URL', () => {
    const result = detectPrhImprint({
      opfContent: '',
      filePaths: ['EPUB/Cornerstone-saga/saga_socials.xhtml'],
      contentSample: 'Sign up at penguin.co.uk/pennystreet',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('cornerstone-saga');
  });

  it('picks the imprint with the highest score when multiple match weakly', () => {
    // Stronger Puffin signals (file path = score 2 each, repeated) should
    // win over a single weak Penguin URL match.
    const result = detectPrhImprint({
      opfContent: PRH_PUBLISHER_OPF,
      filePaths: [
        'EPUB/Puffin/title.xhtml',
        'EPUB/Puffin/brand_page.xhtml',
        'EPUB/images/puffin_logo.png',
      ],
      contentSample: 'A passing mention of penguin.co.uk',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('puffin');
  });

  it('records a signal for every matched pattern (auditable trail)', () => {
    const result = detectPrhImprint({
      opfContent: PRH_PUBLISHER_OPF,
      filePaths: [
        'EPUB/prh_core_assets/images/prh_uk_logo.jpg',
        'EPUB/Penguin/title.xhtml',
        'EPUB/images/penguin-cover.jpg',
      ],
      contentSample: 'Visit twitter.com/penguinukbooks',
    });
    // Should have: publisher-text-opf + prh-core-assets-path + prh-uk-logo-asset
    // + at least one imprint-path-penguin signal + url signal.
    expect(result.signals.length).toBeGreaterThanOrEqual(4);
    expect(result.imprint).toBe('penguin');
  });

  it('does NOT pin a Vintage book as Penguin just because it carries the shared penguin.co.uk a11y URL', () => {
    // Regression: every PRH-UK EPUB's accessibility-summary metadata
    // references penguin.co.uk/accessibility regardless of imprint. That
    // bare URL must not count as Penguin-imprint evidence — the
    // imprint-specific signal here is `vintage-books.co.uk`.
    const result = detectPrhImprint({
      opfContent: `${PRH_PUBLISHER_OPF}
        <meta property="schema:accessibilitySummary">
          ... visit us at penguin.co.uk/accessibility ...
        </meta>`,
      filePaths: [
        'EPUB/vintage/copyright.xhtml',
        'EPUB/vintage/title.xhtml',
      ],
      contentSample: 'Find more at www.vintage-books.co.uk',
    });
    expect(result.imprint).toBe('vintage');
  });

  it('does NOT pin a generic PRH book as Penguin just because of the shared penguin.co.uk a11y URL', () => {
    // No imprint-specific path/text/url evidence — only the publisher-level
    // signal plus the shared accessibility URL. Should resolve to 'unknown',
    // not 'penguin'.
    const result = detectPrhImprint({
      opfContent: `${PRH_PUBLISHER_OPF}
        <meta property="schema:accessibilitySummary">
          ... penguin.co.uk/accessibility ...
        </meta>`,
      filePaths: ['EPUB/xhtml/cover.xhtml'],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(true);
    expect(result.imprint).toBe('unknown');
  });

  it('handles empty input without throwing', () => {
    const result = detectPrhImprint({
      opfContent: '',
      filePaths: [],
      contentSample: '',
    });
    expect(result.isPrhUk).toBe(false);
    expect(result.imprint).toBeNull();
    expect(result.signals).toEqual([]);
  });
});
