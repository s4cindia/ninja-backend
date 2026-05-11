import { describe, it, expect } from 'vitest';
import { validatePrhSocials } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/socials-validator';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';
import type { ImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/_types';

/** Compliant Penguin socials page — 7 channels in canonical order + strapline. */
function compliantPenguinSocials(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Follow Penguin</title></head>
<body epub:type="backmatter">
  <h2>Follow Penguin</h2>
  <ul>
    <li><a href="https://twitter.com/penguinukbooks">Twitter @penguinukbooks</a></li>
    <li><a href="https://facebook.com/penguinbooks">Facebook</a></li>
    <li><a href="https://instagram.com/penguinukbooks">Instagram</a></li>
    <li><a href="https://youtube.com/penguinbooks">YouTube</a></li>
    <li><a href="https://pinterest.com/penguinukbooks">Pinterest</a></li>
    <li><a href="https://linkedin.com/company/penguin-random-house-uk">LinkedIn</a></li>
    <li><a href="https://tiktok.com/@penguinukbooks">TikTok</a></li>
  </ul>
  <p>Find out more about the author and discover your next read at Penguin.co.uk.</p>
</body>
</html>`;
}

function compliantVintageSocials(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Follow Vintage</title></head>
<body epub:type="backmatter">
  <h2>Follow Vintage</h2>
  <p>Twitter @vintagebooks</p>
  <p>Instagram @vintagebooks</p>
  <p>TikTok @vintageukbooks</p>
  <p>Facebook @vintagebooks</p>
  <p>World-class writing. Beautiful design. Ideas that matter.</p>
</body>
</html>`;
}

function compliantCornerstoneSagaSocials(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Saga Socials</title></head>
<body epub:type="backmatter">
  <p><a href="https://www.facebook.com/welcometopennystreet/">Welcome to Penny Street on Facebook</a></p>
  <p>Sign up for the newsletter: www.penguin.co.uk/pennystreet</p>
</body>
</html>`;
}

function input(files: PrhXhtmlFile[], imprintRules: ImprintRules) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test Book',
    xhtmlFiles: files,
    imprintRules,
  };
}

describe('validatePrhSocials — Penguin (full 7-channel page)', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits zero issues for a fully compliant Penguin socials page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin.xhtml',
      content: compliantPenguinSocials(),
    };
    expect(validatePrhSocials(input([file], penguinRules))).toEqual([]);
  });

  it('emits PRH-SOCIALS-PAGE-MISSING when no socials page exists', () => {
    const issues = validatePrhSocials(input([], penguinRules));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-SOCIALS-PAGE-MISSING');
  });

  it('emits PRH-SOCIALS-CHANNEL-MISSING when TikTok is absent', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin.xhtml',
      content: compliantPenguinSocials().replace(/.*tiktok.*\n/, ''),
    };
    const issues = validatePrhSocials(input([file], penguinRules));
    const missing = issues.find((i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING');
    expect(missing).toBeDefined();
    expect(missing?.message).toMatch(/tiktok/i);
  });

  it('emits PRH-SOCIALS-HANDLE-WRONG when Twitter points at the wrong account', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin.xhtml',
      // twitter.com URL prefix is present but with the wrong handle:
      // a HANDLE-WRONG should fire, NOT a CHANNEL-MISSING.
      content: compliantPenguinSocials().replace('twitter.com/penguinukbooks', 'twitter.com/penguinbooks'),
    };
    const issues = validatePrhSocials(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-HANDLE-WRONG')).toBeDefined();
    // And NOT a duplicate CHANNEL-MISSING for the same channel.
    const missingForTwitter = issues.find(
      (i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING' && /twitter/i.test(i.message),
    );
    expect(missingForTwitter).toBeUndefined();
  });

  it('emits PRH-SOCIALS-CHANNEL-ORDER-WRONG when LinkedIn and TikTok swap positions', () => {
    const swapped = compliantPenguinSocials()
      .replace(
        /<li><a href="https:\/\/linkedin\.com[^"]*">LinkedIn<\/a><\/li>\s*<li><a href="https:\/\/tiktok\.com[^"]*">TikTok<\/a><\/li>/,
        '<li><a href="https://tiktok.com/@penguinukbooks">TikTok</a></li><li><a href="https://linkedin.com/company/penguin-random-house-uk">LinkedIn</a></li>',
      );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/follow_penguin.xhtml', content: swapped };
    const issues = validatePrhSocials(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-CHANNEL-ORDER-WRONG')).toBeDefined();
  });

  it('emits PRH-SOCIALS-STRAPLINE-MISSING when the closing strapline is dropped', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin.xhtml',
      content: compliantPenguinSocials().replace(/Find out more about the author[^<]*/, ''),
    };
    const issues = validatePrhSocials(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-STRAPLINE-MISSING')).toBeDefined();
  });

  it('finds the socials page via fingerprint when filename is unconventional', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/end_matter_03.xhtml',
      content: compliantPenguinSocials(),
    };
    expect(validatePrhSocials(input([file], penguinRules))).toEqual([]);
  });
});

describe('validatePrhSocials — Vintage (4 channels + bespoke strapline)', () => {
  const vintageRules = getImprintRules('vintage')!;

  it('emits zero issues for a fully compliant Vintage socials page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage/vin_endpage_socials.xhtml',
      content: compliantVintageSocials(),
    };
    expect(validatePrhSocials(input([file], vintageRules))).toEqual([]);
  });

  it('emits PRH-SOCIALS-STRAPLINE-MISSING when the Vintage strapline is dropped', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage/vin_endpage_socials.xhtml',
      content: compliantVintageSocials().replace(/World-class writing[^<]*/, ''),
    };
    const issues = validatePrhSocials(input([file], vintageRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-STRAPLINE-MISSING')).toBeDefined();
  });

  it('does not flag Twitter as having the wrong handle when @vintagebooks is present', () => {
    // Vintage's "handle" is just `@vintagebooks`, not a URL — the
    // validator should treat the handle string as present even though
    // no `twitter.com/vintagebooks` URL exists in the page.
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage/vin_endpage_socials.xhtml',
      content: compliantVintageSocials(),
    };
    const issues = validatePrhSocials(input([file], vintageRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-HANDLE-WRONG')).toBeUndefined();
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING')).toBeUndefined();
  });
});

describe('validatePrhSocials — Cornerstone Saga (newsletter + Facebook)', () => {
  const sagaRules = getImprintRules('cornerstone-saga')!;

  it('emits zero issues for a compliant Saga socials page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/Cornerstone-saga/saga_socials.xhtml',
      content: compliantCornerstoneSagaSocials(),
    };
    expect(validatePrhSocials(input([file], sagaRules))).toEqual([]);
  });

  it('emits PRH-SOCIALS-CHANNEL-MISSING when the newsletter URL is missing', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/Cornerstone-saga/saga_socials.xhtml',
      content: compliantCornerstoneSagaSocials().replace('penguin.co.uk/pennystreet', ''),
    };
    const issues = validatePrhSocials(input([file], sagaRules));
    const missing = issues.find((i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING');
    expect(missing).toBeDefined();
    expect(missing?.message).toMatch(/newsletter/i);
  });
});

describe('validatePrhSocials — Vintage ambiguous handle regression', () => {
  const vintageRules = getImprintRules('vintage')!;

  it('flags order error when twitter and instagram swap positions (detector regression)', () => {
    // Three Vintage channels share the bare handle "@vintagebooks";
    // the order check must rely on per-channel detectors, not on
    // raw indexOf. Swapping twitter and instagram blocks should fire
    // CHANNEL-ORDER-WRONG even though "@vintagebooks" first occurs
    // at the same position regardless of which line is first.
    const swapped = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Follow Vintage</title></head>
<body epub:type="backmatter">
  <p>Instagram @vintagebooks</p>
  <p>Twitter @vintagebooks</p>
  <p>TikTok @vintageukbooks</p>
  <p>Facebook @vintagebooks</p>
  <p>World-class writing. Beautiful design. Ideas that matter.</p>
</body>
</html>`;
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage/vin_endpage_socials.xhtml',
      content: swapped,
    };
    const issues = validatePrhSocials(input([file], vintageRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-CHANNEL-ORDER-WRONG')).toBeDefined();
  });

  it('reports twitter as missing when only the bare @vintagebooks appears with no "Twitter" keyword nearby', () => {
    // The handle string is shared across three channels; without the
    // channel keyword the detector should not match → twitter shows
    // up as MISSING rather than silently passing on the shared handle.
    const noTwitterKeyword = `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="backmatter">
  <p>Instagram @vintagebooks</p>
  <p>TikTok @vintageukbooks</p>
  <p>Facebook @vintagebooks</p>
  <p>World-class writing. Beautiful design. Ideas that matter.</p>
</body>
</html>`;
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/vintage/vin_endpage_socials.xhtml',
      content: noTwitterKeyword,
    };
    const issues = validatePrhSocials(input([file], vintageRules));
    const missingTwitter = issues.find(
      (i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING' && /twitter/i.test(i.message),
    );
    expect(missingTwitter).toBeDefined();
  });
});

describe('validatePrhSocials — Penguin YA cut-down variant', () => {
  const penguinRules = getImprintRules('penguin')!;

  function compliantPenguinYaSocials(): string {
    return `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body epub:type="backmatter">
  <h2>Follow Penguin YA</h2>
  <ul>
    <li><a href="https://instagram.com/penguinukbooks">Instagram</a></li>
    <li><a href="https://youtube.com/penguinbooks">YouTube</a></li>
    <li><a href="https://tiktok.com/@houseofya">TikTok</a></li>
  </ul>
</body>
</html>`;
  }

  it('emits zero issues for a compliant Penguin YA page (Instagram + YouTube + TikTok @houseofya)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin_ya.xhtml',
      content: compliantPenguinYaSocials(),
    };
    expect(validatePrhSocials(input([file], penguinRules))).toEqual([]);
  });

  it('does NOT flag the missing 4 channels that the full Penguin page requires (Twitter, Facebook, Pinterest, LinkedIn)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin_ya.xhtml',
      content: compliantPenguinYaSocials(),
    };
    const issues = validatePrhSocials(input([file], penguinRules));
    for (const channelId of ['twitter', 'facebook', 'pinterest', 'linkedin']) {
      const missing = issues.find(
        (i) => i.code === 'PRH-SOCIALS-CHANNEL-MISSING' && i.message.toLowerCase().includes(channelId),
      );
      expect(missing, `${channelId} should not be flagged on the YA variant`).toBeUndefined();
    }
  });

  it('still flags YA-page issues if the TikTok handle uses the full-Penguin account (@penguinukbooks)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin_ya.xhtml',
      content: compliantPenguinYaSocials().replace('tiktok.com/@houseofya', 'tiktok.com/@penguinukbooks'),
    };
    const issues = validatePrhSocials(input([file], penguinRules));
    expect(issues.find((i) => i.code === 'PRH-SOCIALS-HANDLE-WRONG')).toBeDefined();
  });
});

describe('validatePrhSocials — imprints without a canonical socials page', () => {
  it('Puffin emits zero socials issues regardless of EPUB content', () => {
    const puffinRules = getImprintRules('puffin')!;
    expect(validatePrhSocials(input([], puffinRules))).toEqual([]);
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/follow_penguin.xhtml',
      content: compliantPenguinSocials(),
    };
    expect(validatePrhSocials(input([file], puffinRules))).toEqual([]);
  });

  it('Pelican, Ladybird, and #Merky emit zero socials issues', () => {
    for (const imp of ['pelican', 'ladybird', 'merky'] as const) {
      const rules = getImprintRules(imp)!;
      expect(validatePrhSocials(input([], rules))).toEqual([]);
    }
  });
});
