import { describe, it, expect } from 'vitest';
import {
  acrGeneratorService,
  type AcrEdition,
  type ProductInfo,
} from '../../../../src/services/acr/acr-generator.service';
import { VPAT_PRH_UK_TEMPLATE } from '../../../../src/services/acr/templates/vpat-prh-uk-template';

const PRODUCT_INFO: ProductInfo = {
  name: 'Sample Title',
  version: '1.0.0',
  description: 'Sample EPUB for ACR generation tests',
  vendor: 'Test Publisher',
  contactEmail: 'test@example.com',
  evaluationDate: new Date('2026-05-11'),
};

describe('AcrGeneratorService — VPAT2.5-PRH-UK edition', () => {
  it('appears in getEditions() alongside the existing 4 editions', () => {
    const { editions } = acrGeneratorService.getEditions();
    const codes = editions.map((e) => e.id).sort();
    expect(codes).toContain('VPAT2.5-PRH-UK');
    expect(codes).toContain('VPAT2.5-INT');
    expect(codes).toContain('VPAT2.5-508');
    expect(codes).toContain('VPAT2.5-WCAG');
    expect(codes).toContain('VPAT2.5-EU');
  });

  it('exposes edition metadata pinned to WCAG 2.2 + EPUB Accessibility 1.1', () => {
    const info = acrGeneratorService.getEditionInfo('VPAT2.5-PRH-UK');
    expect(info).toBeDefined();
    expect(info?.name).toMatch(/PRH UK/i);
    expect(info?.standards).toContain('WCAG 2.2');
    expect(info?.standards).toContain('EPUB Accessibility 1.1');
    // PRH-UK is intentionally not the recommended default (international
    // remains the global recommendation).
    expect(info?.recommended).toBe(false);
  });

  it('getCriteriaForEdition includes WCAG 2.2 Level A + AA but excludes AAA', async () => {
    const criteria = await acrGeneratorService.getCriteriaForEdition('VPAT2.5-PRH-UK');
    const levels = new Set(criteria.map((c) => c.level));
    expect(levels.has('A')).toBe(true);
    expect(levels.has('AA')).toBe(true);
    // PRH UK's published target is AA — no AAA criteria in this edition.
    expect(levels.has('AAA')).toBe(false);
  });

  it('includes the six new WCAG 2.2 A/AA criteria over the 2.1 base', async () => {
    const criteria = await acrGeneratorService.getCriteriaForEdition('VPAT2.5-PRH-UK');
    const ids = new Set(criteria.map((c) => c.id));
    // The six new 2.2 A/AA criteria (Style/Technical Guide pin to 2.2 AA).
    expect(ids.has('2.4.11')).toBe(true);  // Focus Not Obscured (Minimum) — AA
    expect(ids.has('2.5.7')).toBe(true);   // Dragging Movements — AA
    expect(ids.has('2.5.8')).toBe(true);   // Target Size (Minimum) — AA
    expect(ids.has('3.2.6')).toBe(true);   // Consistent Help — A
    expect(ids.has('3.3.7')).toBe(true);   // Redundant Entry — A
    expect(ids.has('3.3.8')).toBe(true);   // Accessible Authentication (Min) — AA
    // AAA-only 2.2 additions should NOT be present.
    expect(ids.has('2.4.12')).toBe(false); // Focus Not Obscured (Enhanced) — AAA
    expect(ids.has('3.3.9')).toBe(false);  // Accessible Authentication (Enhanced) — AAA
  });

  it('includes WCAG 2.1 AA criterion 1.2.4 Captions (Live) — regression', async () => {
    // Regression for CodeRabbit P2: getWcag21BaseCriteria previously
    // omitted 1.2.4 (Captions (Live), AA). For a report claiming WCAG 2.2
    // Level AA conformance, omitting an AA criterion is a hard gap.
    const criteria = await acrGeneratorService.getCriteriaForEdition('VPAT2.5-PRH-UK');
    const c124 = criteria.find((c) => c.id === '1.2.4');
    expect(c124).toBeDefined();
    expect(c124?.level).toBe('AA');
    expect(c124?.name).toMatch(/Captions \(Live\)/i);
  });

  it('still contains the WCAG 2.1 base criteria (no regression in coverage)', async () => {
    const criteria = await acrGeneratorService.getCriteriaForEdition('VPAT2.5-PRH-UK');
    const ids = new Set(criteria.map((c) => c.id));
    // Spot-check a handful of 2.1 criteria that are core to EPUB
    // accessibility — they must still be present.
    for (const id of ['1.1.1', '1.3.1', '2.4.5', '3.1.1', '4.1.2']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('does not duplicate criteria when 2.1 and 2.2 lists overlap (defensive)', async () => {
    const criteria = await acrGeneratorService.getCriteriaForEdition('VPAT2.5-PRH-UK');
    const ids = criteria.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('generates an AcrDocument with publisherMetadata pinned to PRH UK values', async () => {
    const doc = await acrGeneratorService.generateAcr('test-job', {
      edition: 'VPAT2.5-PRH-UK',
      productInfo: PRODUCT_INFO,
    });
    expect(doc.edition).toBe('VPAT2.5-PRH-UK');
    expect(doc.publisherMetadata).toBeDefined();
    expect(doc.publisherMetadata?.certifiedBy).toBe('Penguin Random House UK');
    expect(doc.publisherMetadata?.certifierCredential).toBe('Ace by DAISY OK');
    expect(doc.publisherMetadata?.credentialUrl).toBe('https://daisy.github.io/ace');
    expect(doc.publisherMetadata?.conformsTo).toBe('EPUB Accessibility 1.1 - WCAG 2.2 Level AA');
    expect(doc.publisherMetadata?.accessibilitySummaryUrl).toBe('https://www.penguin.co.uk/accessibility');
    expect(doc.publisherMetadata?.tdmReservationNote).toMatch(/DSM Directive 2019\/790/);
  });

  it('non-PRH editions do NOT receive publisherMetadata', async () => {
    const editions: AcrEdition[] = ['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT'];
    for (const edition of editions) {
      const doc = await acrGeneratorService.generateAcr('test-job', {
        edition,
        productInfo: PRODUCT_INFO,
      });
      expect(doc.publisherMetadata).toBeUndefined();
    }
  });

  it('PRH UK getEditionDetails groups criteria into Level A and Level AA sections', async () => {
    const details = await acrGeneratorService.getEditionDetails('VPAT2.5-PRH-UK');
    expect(details).toBeDefined();
    expect(details?.sections.some((s) => s.id === 'level-a')).toBe(true);
    expect(details?.sections.some((s) => s.id === 'level-aa')).toBe(true);
    // No AAA section — PRH targets AA.
    expect(details?.sections.some((s) => s.id === 'level-aaa')).toBe(false);
  });

  it('template constant agrees with the runtime edition definition (single source of truth)', () => {
    // The template file is declarative metadata; the runtime EDITION_INFO
    // is what generateAcr actually reads. They must agree on the literal
    // PRH-required strings so a future template renderer doesn't drift.
    expect(VPAT_PRH_UK_TEMPLATE.edition).toBe('VPAT2.5-PRH-UK');
    expect(VPAT_PRH_UK_TEMPLATE.accessibilityConformsTo).toBe('EPUB Accessibility 1.1 - WCAG 2.2 Level AA');
    expect(VPAT_PRH_UK_TEMPLATE.certifier.certifiedBy).toBe('Penguin Random House UK');
    expect(VPAT_PRH_UK_TEMPLATE.certifier.certifierCredential).toBe('Ace by DAISY OK');
    expect(VPAT_PRH_UK_TEMPLATE.accessibilitySummaryUrl).toBe('https://www.penguin.co.uk/accessibility');
    expect(VPAT_PRH_UK_TEMPLATE.tdmReservation).toBe(true);
  });
});
