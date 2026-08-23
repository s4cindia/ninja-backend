/**
 * Color Contrast Correction
 *
 * Pure color math — no pdf-lib, no pdfjs, no PDF I/O. Given a failing
 * foreground/background color pair, computes a corrected foreground color
 * that clears a target WCAG contrast ratio with the smallest perceptual
 * change (adjusts lightness in HSL space, preserving hue and saturation).
 *
 * Scoped to PDF color-contrast auto-fix (Phase B0). Not wired into the EPUB
 * path (`epub-modifier.service.ts`'s findCompliantColor), which has its own
 * RGB-channel-interpolation implementation — unifying the two is a separate,
 * later effort, not part of this change.
 */

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

export interface CompliantColorResult {
  /** Corrected color, as "#rrggbb" (lowercase). */
  color: string;
  /** Contrast ratio actually achieved by `color` against the given background. */
  appliedRatio: number;
  /** Which way lightness moved to reach it. 'none' when the input already passed. */
  direction: 'lighten' | 'darken' | 'none';
}

// Lightness search step and cap — 1% steps, full range in the worst case.
const LIGHTNESS_STEP = 0.01;
const MAX_STEPS = 101;

// Absorbs the pixel-sampling noise in PdfContrastValidator's measured colors
// (they're rendered-pixel averages, not the literal original operator value) —
// targeting the exact threshold risks a fix that re-audits at e.g. 4.51:1 and
// regresses on the next render pass.
const RATIO_SAFETY_MARGIN = 0.2;

function hexToRgb(hex: string): RgbColor {
  const clean = hex.replace(/^#/, '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

function rgbToHex(rgb: RgbColor): string {
  const toHex = (n: number) => {
    const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function rgbToHsl(rgb: RgbColor): HslColor {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  switch (max) {
    case r: h = ((g - b) / d) % 6; break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4; break;
  }
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(hsl: HslColor): RgbColor {
  const { h, s, l } = hsl;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  };
}

/** WCAG relative luminance — same formula as PdfContrastValidator.getLuminance. */
function getLuminance(rgb: RgbColor): number {
  const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map(c => {
    const val = c / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(a: RgbColor, b: RgbColor): number {
  const l1 = getLuminance(a);
  const l2 = getLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Steps lightness away from `hsl.l` toward 0 (darken) or 1 (lighten) in fixed
 * increments — not a binary search — because contrast ratio isn't guaranteed
 * monotonic in lightness across the full [0,1] range (it dips near wherever
 * the foreground's luminance crosses the background's), only monotonic
 * enough locally for this to matter in pathological cases. A stepped scan
 * from the starting point is simple and robust regardless.
 */
function searchDirection(
  hsl: HslColor,
  bg: RgbColor,
  target: number,
  dir: 'darken' | 'lighten'
): { l: number; ratio: number } | null {
  for (let i = 1; i <= MAX_STEPS; i++) {
    const delta = i * LIGHTNESS_STEP;
    const l = dir === 'darken' ? Math.max(0, hsl.l - delta) : Math.min(1, hsl.l + delta);
    const ratio = contrastRatio(hslToRgb({ h: hsl.h, s: hsl.s, l }), bg);
    if (ratio >= target) return { l, ratio };
    if (l === 0 || l === 1) break;
  }
  return null;
}

/**
 * Computes a corrected foreground color that clears `requiredRatio` against
 * `bgHex`, adjusting `fgHex`'s lightness by the smallest amount that does so
 * (preserving hue/saturation), with a pure-black/pure-white fallback when
 * neither lightening nor darkening alone is enough (possible against a
 * mid-gray background — both extremes are checked, not assumed to work).
 */
export function computeCompliantColor(
  fgHex: string,
  bgHex: string,
  requiredRatio: number
): CompliantColorResult {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  const target = requiredRatio + RATIO_SAFETY_MARGIN;
  const currentRatio = contrastRatio(fg, bg);

  if (currentRatio >= target) {
    return { color: rgbToHex(fg), appliedRatio: round2(currentRatio), direction: 'none' };
  }

  const hsl = rgbToHsl(fg);
  const darkened = searchDirection(hsl, bg, target, 'darken');
  const lightened = searchDirection(hsl, bg, target, 'lighten');

  const candidates: Array<{ l: number; ratio: number; direction: 'darken' | 'lighten'; delta: number }> = [];
  if (darkened) candidates.push({ ...darkened, direction: 'darken', delta: hsl.l - darkened.l });
  if (lightened) candidates.push({ ...lightened, direction: 'lighten', delta: lightened.l - hsl.l });

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.delta - b.delta);
    const best = candidates[0];
    const rgb = hslToRgb({ h: hsl.h, s: hsl.s, l: best.l });
    return { color: rgbToHex(rgb), appliedRatio: round2(best.ratio), direction: best.direction };
  }

  // Neither extreme clears the target — fall back to whichever pure black/white wins.
  const blackRatio = contrastRatio({ r: 0, g: 0, b: 0 }, bg);
  const whiteRatio = contrastRatio({ r: 255, g: 255, b: 255 }, bg);
  return blackRatio >= whiteRatio
    ? { color: '#000000', appliedRatio: round2(blackRatio), direction: 'darken' }
    : { color: '#ffffff', appliedRatio: round2(whiteRatio), direction: 'lighten' };
}
