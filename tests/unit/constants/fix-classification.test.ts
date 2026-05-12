import { describe, it, expect } from 'vitest';
import {
  getFixType,
  AUTO_FIXABLE_CODES,
  QUICK_FIXABLE_CODES,
} from '../../../src/constants/fix-classification';

describe('getFixType — quick-fix routing', () => {
  it('routes EPUB-IMG-001 to quickfix (sanity baseline)', () => {
    expect(getFixType('EPUB-IMG-001')).toBe('quickfix');
  });

  it('routes PRH-COVER-ALT-EMPTY to quickfix (P2-P3 FE Prompt 3)', () => {
    // PRH cover-alt is operator-supplied; the FE quick-fix dialog
    // collects the alt text and POSTs it through the same payload
    // shape as EPUB-IMG-001. Wired up in epub.controller.ts arms in
    // applyQuickFix + applyBatchQuickFix.
    expect(getFixType('PRH-COVER-ALT-EMPTY')).toBe('quickfix');
  });

  it('routes an unknown PRH code to manual (default fallback)', () => {
    expect(getFixType('PRH-UNKNOWN-CODE-XYZ')).toBe('manual');
  });
});

describe('QUICK_FIXABLE_CODES set membership', () => {
  it('includes PRH-COVER-ALT-EMPTY', () => {
    expect(QUICK_FIXABLE_CODES.has('PRH-COVER-ALT-EMPTY')).toBe(true);
  });

  it('does NOT promote PRH-COVER-ALT-EMPTY to auto-fixable (operator must supply alt)', () => {
    // PRH explicitly requires operator-supplied alt for the cover
    // image; never auto-fabricated. Guards against accidental
    // promotion to AUTO_FIXABLE_CODES.
    expect(AUTO_FIXABLE_CODES.has('PRH-COVER-ALT-EMPTY')).toBe(false);
  });
});
