import { describe, it, expect } from 'vitest';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';

describe('getImprintRules', () => {
  it('returns null for null imprint', () => {
    expect(getImprintRules(null)).toBeNull();
  });

  it('returns null for "unknown" imprint', () => {
    expect(getImprintRules('unknown')).toBeNull();
  });

  it('returns rules for each first-class imprint', () => {
    const imprints = ['penguin', 'puffin', 'vintage', 'pelican', 'ladybird', 'merky', 'cornerstone-saga'] as const;
    for (const imprint of imprints) {
      const rules = getImprintRules(imprint);
      expect(rules, `${imprint} should have rules`).toBeDefined();
      expect(rules?.imprint).toBe(imprint);
    }
  });

  it('Penguin uses the adult copyright template', () => {
    const rules = getImprintRules('penguin');
    expect(rules?.copyrightTemplate).toBe('adult');
  });

  it('Puffin uses the children\'s copyright template', () => {
    const rules = getImprintRules('puffin');
    expect(rules?.copyrightTemplate).toBe('children');
  });

  it('Ladybird uses the children\'s copyright template', () => {
    const rules = getImprintRules('ladybird');
    expect(rules?.copyrightTemplate).toBe('children');
  });

  it('Vintage uses the bespoke copyright template', () => {
    const rules = getImprintRules('vintage');
    expect(rules?.copyrightTemplate).toBe('vintage-bespoke');
  });

  it('adult imprints include the TDM-reservation check', () => {
    const adultImprints = ['penguin', 'pelican', 'merky', 'cornerstone-saga'] as const;
    for (const imprint of adultImprints) {
      const rules = getImprintRules(imprint);
      const tdmCheck = rules?.copyrightContentChecks.find((c) => c.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING');
      expect(tdmCheck, `${imprint} should have TDM check`).toBeDefined();
    }
  });

  it('children\'s imprints include all three URL checks (penguin + puffin + ladybird)', () => {
    const childrensImprints = ['puffin', 'ladybird'] as const;
    for (const imprint of childrensImprints) {
      const rules = getImprintRules(imprint);
      const urlChecks = rules?.copyrightContentChecks.filter((c) => c.code === 'PRH-COPY-IMPRINT-URL-MISSING') ?? [];
      const needles = urlChecks.map((c) => c.needle);
      expect(needles).toContain('penguin.co.uk');
      expect(needles).toContain('puffin.co.uk');
      expect(needles).toContain('ladybird.co.uk');
    }
  });

  it('Vintage does NOT include TDM or EEA checks (template differs)', () => {
    const rules = getImprintRules('vintage');
    const codes = rules?.copyrightContentChecks.map((c) => c.code) ?? [];
    expect(codes).not.toContain('PRH-COPY-TDM-PARAGRAPH-MISSING');
    expect(codes).not.toContain('PRH-COPY-EEA-LINE-MISSING');
  });

  it('Vintage uses its own address (20 Vauxhall Bridge Road)', () => {
    const rules = getImprintRules('vintage');
    const addressCheck = rules?.copyrightContentChecks.find((c) => c.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING');
    expect(addressCheck?.needle).toMatch(/vauxhall bridge road/i);
  });

  it('Vintage uses the vintage-specific URL', () => {
    const rules = getImprintRules('vintage');
    const urlCheck = rules?.copyrightContentChecks.find((c) => c.code === 'PRH-COPY-IMPRINT-URL-MISSING');
    expect(urlCheck?.needle).toBe('penguin.co.uk/vintage');
  });

  it('every check has severity, a needle OR regex, suggestion, and a registered PRH code', () => {
    const imprints = ['penguin', 'puffin', 'vintage', 'pelican', 'ladybird', 'merky', 'cornerstone-saga'] as const;
    for (const imprint of imprints) {
      const rules = getImprintRules(imprint);
      expect(rules).not.toBeNull();
      for (const check of rules!.copyrightContentChecks) {
        expect(check.code, `${imprint}: ${check.code} should start with PRH-COPY-`).toMatch(/^PRH-COPY-/);
        // Every check must have either a needle OR a regex (validator
        // short-circuits if neither is set, which would be a silent
        // false-pass — guard against it).
        const hasNeedle = typeof check.needle === 'string' && check.needle.length > 0;
        const hasRegex = check.regex instanceof RegExp;
        expect(hasNeedle || hasRegex, `${imprint}: ${check.code} must have needle or regex`).toBe(true);
        expect(check.suggestion.length).toBeGreaterThan(0);
        expect(['minor', 'moderate', 'serious', 'critical']).toContain(check.severity);
      }
    }
  });

  // ── Brand-page rules (P2/PR2) ─────────────────────────────────────────
  it('imprints with a brand page expose the canonical figure class', () => {
    expect(getImprintRules('penguin')?.brandPage?.figureClass).toBe('brand_logo_solo');
    expect(getImprintRules('puffin')?.brandPage?.figureClass).toBe('brand_logo_solo');
    expect(getImprintRules('pelican')?.brandPage?.figureClass).toBe('brand_logo_solo');
    expect(getImprintRules('ladybird')?.brandPage?.figureClass).toBe('brand_logo_solo');
  });

  it('Vintage uses .image_full on its brand page (not .brand_logo_solo)', () => {
    expect(getImprintRules('vintage')?.brandPage?.figureClass).toBe('image_full');
  });

  it('#Merky and Cornerstone Saga have no brand page', () => {
    expect(getImprintRules('merky')?.brandPage).toBeNull();
    expect(getImprintRules('cornerstone-saga')?.brandPage).toBeNull();
  });

  it('brand-page logo alts match the marketing names', () => {
    expect(getImprintRules('penguin')?.brandPage?.logoAlt).toBe('Penguin Random House');
    expect(getImprintRules('puffin')?.brandPage?.logoAlt).toBe('Puffin Books');
    expect(getImprintRules('vintage')?.brandPage?.logoAlt).toBe('Vintage Books');
    expect(getImprintRules('pelican')?.brandPage?.logoAlt).toBe('Pelican Books');
    expect(getImprintRules('ladybird')?.brandPage?.logoAlt).toBe('Ladybird Books');
  });

  // ── Title-page rules (P2/PR2) ─────────────────────────────────────────
  it('imprints with a structured title page expose logo alt', () => {
    expect(getImprintRules('penguin')?.titlePage?.logoAlt).toBe('Penguin Random House');
    expect(getImprintRules('pelican')?.titlePage?.logoAlt).toBe('Pelican Books');
    expect(getImprintRules('ladybird')?.titlePage?.logoAlt).toBe('Ladybird Books');
    expect(getImprintRules('merky')?.titlePage?.logoAlt).toBe('Penguin Random House');
  });

  it('Puffin uses the image-only title page', () => {
    const titlePage = getImprintRules('puffin')?.titlePage;
    expect(titlePage?.imageOnly).toBe(true);
  });

  it('Vintage and Cornerstone Saga have no separate title page', () => {
    expect(getImprintRules('vintage')?.titlePage).toBeNull();
    expect(getImprintRules('cornerstone-saga')?.titlePage).toBeNull();
  });

  // ── Socials rules (P2/PR3) ────────────────────────────────────────────
  it('Penguin defines the full 7-channel socials list in canonical order', () => {
    const socials = getImprintRules('penguin')?.socials;
    expect(socials).not.toBeNull();
    const ids = socials?.channels.map((c) => c.id) ?? [];
    expect(ids).toEqual([
      'twitter', 'facebook', 'instagram', 'youtube', 'pinterest', 'linkedin', 'tiktok',
    ]);
  });

  it('Penguin TikTok handle is @penguinukbooks (not @penguinbooks)', () => {
    const socials = getImprintRules('penguin')?.socials;
    const tiktok = socials?.channels.find((c) => c.id === 'tiktok');
    expect(tiktok?.handle).toBe('tiktok.com/@penguinukbooks');
  });

  it('Vintage TikTok handle differs from the rest (@vintageukbooks)', () => {
    const socials = getImprintRules('vintage')?.socials;
    const tiktok = socials?.channels.find((c) => c.id === 'tiktok');
    expect(tiktok?.handle).toBe('@vintageukbooks');
  });

  it('Vintage strapline is the Branding Guide §6 verbatim phrase', () => {
    expect(getImprintRules('vintage')?.socials?.strapline)
      .toBe('World-class writing. Beautiful design. Ideas that matter.');
  });

  it('Cornerstone Saga has a slim 2-channel socials list (Facebook + Newsletter)', () => {
    const ids = getImprintRules('cornerstone-saga')?.socials?.channels.map((c) => c.id) ?? [];
    expect(ids).toEqual(['facebook', 'newsletter']);
  });

  it('Puffin / Pelican / Ladybird / #Merky have no socials page', () => {
    expect(getImprintRules('puffin')?.socials).toBeNull();
    expect(getImprintRules('pelican')?.socials).toBeNull();
    expect(getImprintRules('ladybird')?.socials).toBeNull();
    expect(getImprintRules('merky')?.socials).toBeNull();
  });
});
