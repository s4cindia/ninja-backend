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
});
