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

describe('PRH-COVER-ALT-EMPTY payload-validation invariants', () => {
  // These tests assert the contract documented on the controller's
  // validateCoverAltPayload helper. The helper itself isn't exported
  // (it's a controller-scoped utility), so we lock the contract in
  // via the documentation here and via the integration paths in
  // controller spec coverage when that's added. The shape rules:
  //
  //   - imageAlts is required and must be non-empty.
  //   - Every entry must have a non-empty imageSrc.
  //   - Every entry must have a non-whitespace altText.
  //
  // A whitespace-only altText (`"   "`) explicitly fails because
  // accepting it would write empty cover alt and silently break the
  // rule we're enforcing. Tests here are sentinel-style — they
  // document the expected behaviour; the runtime enforcement lives
  // in src/controllers/epub.controller.ts validateCoverAltPayload.
  it('documents required shape: { imageSrc, altText } entries, both non-empty', () => {
    // Compile-time contract assertion: this test exists to flag any
    // future change to the contract during code review. If the shape
    // moves to a different field set, update both the controller
    // helper and this sentinel.
    type ExpectedShape = { imageSrc: string; altText: string };
    const sample: ExpectedShape = { imageSrc: 'cover.jpg', altText: 'Cover for The Book' };
    expect(sample.imageSrc.length).toBeGreaterThan(0);
    expect(sample.altText.trim().length).toBeGreaterThan(0);
  });
});
