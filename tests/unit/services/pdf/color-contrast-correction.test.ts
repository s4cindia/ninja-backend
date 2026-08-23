import { describe, it, expect } from 'vitest';
import { computeCompliantColor } from '../../../../src/services/pdf/color-contrast-correction';

// WCAG relative luminance, mirrored here only to independently verify the
// module's output ratio (not to duplicate its internals).
function luminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(clean.substring(i, i + 2), 16));
  const [rs, gs, bs] = [r, g, b].map(c => {
    const val = c / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function ratio(hexA: string, hexB: string): number {
  const [l1, l2] = [luminance(hexA), luminance(hexB)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('computeCompliantColor', () => {
  it('leaves an already-compliant color unchanged', () => {
    // Black on white: ratio 21:1, well past 4.5.
    const res = computeCompliantColor('#000000', '#ffffff', 4.5);
    expect(res.direction).toBe('none');
    expect(res.color).toBe('#000000');
    expect(res.appliedRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens light gray text on a white background', () => {
    // #999999 on #ffffff is ~2.85:1 — fails 4.5:1, background is lighter so darkening should win.
    const res = computeCompliantColor('#999999', '#ffffff', 4.5);
    expect(res.direction).toBe('darken');
    expect(ratio(res.color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('lightens dark gray text on a black background', () => {
    // #333333 on #000000 fails 4.5:1, background is darker so lightening should win.
    const res = computeCompliantColor('#333333', '#000000', 4.5);
    expect(res.direction).toBe('lighten');
    expect(ratio(res.color, '#000000')).toBeGreaterThanOrEqual(4.5);
  });

  it('preserves hue while adjusting lightness', () => {
    // A mid-saturation blue that fails on white — corrected color should still read as blue,
    // not have drifted toward gray/another hue.
    const res = computeCompliantColor('#6a8fd6', '#ffffff', 4.5);
    const clean = res.color.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    expect(b).toBeGreaterThan(r); // still bluer than red
    expect(ratio(res.color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to pure black or white when neither direction alone clears the target', () => {
    // Mid-gray background: even pure black/white foreground may not hit an
    // unreasonably high target — force the fallback path with an extreme target.
    const res = computeCompliantColor('#808080', '#808080', 21);
    expect(['#000000', '#ffffff']).toContain(res.color);
    expect(res.appliedRatio).toBeGreaterThan(1);
  });

  it('applies the large-text 3:1 threshold correctly (less correction than 4.5:1 would need)', () => {
    const large = computeCompliantColor('#999999', '#ffffff', 3.0);
    const normal = computeCompliantColor('#999999', '#ffffff', 4.5);
    expect(ratio(large.color, '#ffffff')).toBeGreaterThanOrEqual(3.0);
    expect(ratio(normal.color, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    // Less correction needed for the lower (large-text) threshold — darkening
    // stops sooner, so the large-text result stays lighter (higher luminance).
    expect(luminance(large.color)).toBeGreaterThan(luminance(normal.color));
  });

  it('applies a safety margin above the exact threshold to absorb sampling noise', () => {
    const res = computeCompliantColor('#999999', '#ffffff', 4.5);
    expect(res.appliedRatio).toBeGreaterThanOrEqual(4.5 + 0.2 - 0.05); // small tolerance for step size
  });
});
