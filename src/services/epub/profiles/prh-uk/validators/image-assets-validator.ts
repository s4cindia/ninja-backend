/**
 * PRH UK image-assets validator (P6/PR3).
 *
 * Per Technical Guide §§11-12 image-asset rules:
 *   - Each image has a canonical capture size driven by its CSS
 *     class (e.g. `.portrait_large` → 1900px width). Tolerance is
 *     ±5% to account for legitimate scaling rounding.
 *   - 300dpi minimum density.
 *   - All images converted to sRGB.
 *   - PNG-8 preferred for line drawings / schematics / text glyphs
 *     (heuristic: small-width low-colour-count JPEGs).
 *   - JPEG quality cap at "8" (heuristic on bytes-per-pixel).
 *
 * Detect-only. Auto-resize / re-encode lives in P7 if/when demanded.
 *
 * The validator is pure: the orchestrator runs sharp once per image
 * and passes pre-computed metadata in. Tests therefore don't need
 * sharp — they fabricate metadata directly.
 *
 * Image-class lookup: each rule that depends on the host class
 * (currently only capture-size) walks the XHTML files to find
 * `<img>` elements whose `src` resolves to the image path and
 * collects their `class` tokens.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type {
  PrhValidatorIssue,
  PrhImageAssetsInput,
  PrhImageMetadata,
  PrhXhtmlFile,
} from './types';

const DPI_MIN = 300;
const CAPTURE_SIZE_TOLERANCE = 0.05;
const PNG_EXPECTED_WIDTH_MAX = 800;
const PNG_EXPECTED_COLOR_COUNT_MAX = 256;
const JPEG_QUALITY_BYTES_PER_PIXEL_MAX = 0.5;

/**
 * Canonical capture sizes from Technical Guide §11. Keyed on the
 * CSS class applied to the `<img>`. Wildcard variants (e.g.
 * `image_full_caption_landscape`) are normalised to their base
 * size via the `imageFullVariant` prefix check.
 */
const CAPTURE_SIZES: Record<string, number> = {
  cover_image: 1900,
  portrait_large: 1900,
  portrait_medium: 1600,
  portrait_small: 1024,
  portrait_xsmall: 500,
  landscape_large: 1900,
  landscape_medium: 1600,
  landscape_small: 1024,
  landscape_xsmall: 500,
  plate_image_portrait: 1024,
  plate_image_landscape: 1024,
};

/** Classes that share the 1900px capture size as `image_full`. */
const IMAGE_FULL_PREFIX = 'image_full';

export function validatePrhImageAssets(input: PrhImageAssetsInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  const hostClassMap = buildHostClassMap(input.xhtmlFiles, input.images);

  for (const image of input.images) {
    if (!image.mediaType.startsWith('image/')) continue;

    // 1. Capture size — requires a class match.
    const captureRule = inferCaptureSize(hostClassMap.get(image.path));
    if (captureRule !== null && image.width !== null) {
      const tolerance = captureRule * CAPTURE_SIZE_TOLERANCE;
      if (Math.abs(image.width - captureRule) > tolerance) {
        issues.push(
          buildIssue(
            'PRH-IMG-CAPTURE-SIZE-WRONG',
            image.path,
            ` (actual ${image.width}px, expected ${captureRule}px ±${Math.round(tolerance)}px)`,
          ),
        );
      }
    }

    // 2. DPI minimum. Skip on null (EXIF-stripped).
    if (image.density !== null && image.density > 0 && image.density < DPI_MIN) {
      issues.push(
        buildIssue(
          'PRH-IMG-DPI-TOO-LOW',
          image.path,
          ` (${image.density}dpi < ${DPI_MIN}dpi minimum)`,
        ),
      );
    }

    // 3. sRGB. Skip on null colorSpace.
    if (image.colorSpace !== null && image.colorSpace.toLowerCase() !== 'srgb') {
      issues.push(
        buildIssue(
          'PRH-IMG-COLORSPACE-NOT-SRGB',
          image.path,
          ` (actual: ${image.colorSpace})`,
        ),
      );
    }

    // 4. PNG-expected-JPEG heuristic. Only for JPEGs.
    if (
      image.mediaType === 'image/jpeg'
      && image.width !== null
      && image.colorCount !== null
      && image.width <= PNG_EXPECTED_WIDTH_MAX
      && image.colorCount <= PNG_EXPECTED_COLOR_COUNT_MAX
    ) {
      issues.push(
        buildIssue(
          'PRH-IMG-PNG-EXPECTED-JPEG',
          image.path,
          ` (${image.width}px wide, ${image.colorCount} distinct colours — looks like a line drawing)`,
        ),
      );
    }

    // 5. JPEG quality heuristic. Cover exempt.
    if (
      image.mediaType === 'image/jpeg'
      && !image.isCover
      && image.width !== null
      && image.height !== null
      && image.sizeBytes > 0
    ) {
      const pixels = image.width * image.height;
      if (pixels > 0) {
        const bpp = image.sizeBytes / pixels;
        if (bpp > JPEG_QUALITY_BYTES_PER_PIXEL_MAX) {
          issues.push(
            buildIssue(
              'PRH-IMG-JPEG-QUALITY-SUSPECT',
              image.path,
              ` (${bpp.toFixed(2)} bytes/pixel > ${JPEG_QUALITY_BYTES_PER_PIXEL_MAX} — quality looks higher than the PRH "8" target)`,
            ),
          );
        }
      }
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Walk every XHTML file and build a map from image-path → set of
 * class tokens applied to the `<img>` element that references it.
 * Multiple `<img>` elements can reference the same image (rare but
 * possible), so each path can carry several classes.
 *
 * Image paths are resolved relative to the XHTML file's directory
 * because `<img src="...">` is a sibling-relative reference.
 */
function buildHostClassMap(
  xhtmlFiles: PrhXhtmlFile[],
  images: PrhImageMetadata[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const knownPaths = new Set(images.map((i) => i.path));

  for (const file of xhtmlFiles) {
    const dir = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    // Match <img …> tags; capture the open-tag attribute chunk so we
    // can read src + class independently. The `[^>]*` is fine here
    // because <img> tags cannot legitimately contain '>' inside an
    // attribute value (HTML/XML requires &gt; escaping).
    for (const m of file.content.matchAll(/<img\b([^>]*)>/gi)) {
      const attrs = m[1];
      const srcMatch = attrs.match(/(?:^|\s)src\s*=\s*["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const resolved = resolveRelative(dir, srcMatch[1]);
      if (!knownPaths.has(resolved)) continue;
      const classMatch = attrs.match(/(?:^|\s)class\s*=\s*["']([^"']+)["']/i);
      const tokens = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
      if (tokens.length === 0) continue;
      let set = out.get(resolved);
      if (!set) {
        set = new Set<string>();
        out.set(resolved, set);
      }
      for (const t of tokens) set.add(t);
    }
  }
  return out;
}

/**
 * Pick the canonical capture size for a set of host classes. If
 * none of the classes maps to a known capture size, returns null
 * (no enforcement). When multiple classes match, the first match
 * wins by lookup order — in practice an `<img>` carries at most one
 * size-class.
 */
function inferCaptureSize(classes: Set<string> | undefined): number | null {
  if (!classes) return null;
  for (const cls of classes) {
    if (cls.startsWith(IMAGE_FULL_PREFIX)) return 1900;
    if (cls in CAPTURE_SIZES) return CAPTURE_SIZES[cls];
  }
  return null;
}

/**
 * Resolve a relative `src` against the XHTML file's directory.
 * Mirrors the OPF-relative resolver in run-validators.ts but stays
 * local so this validator has no orchestrator dependencies.
 */
function resolveRelative(dir: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1);
  const combined = dir.length > 0 ? `${dir}/${href}` : href;
  const segments = combined.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

function buildIssue(
  code:
    | 'PRH-IMG-CAPTURE-SIZE-WRONG'
    | 'PRH-IMG-DPI-TOO-LOW'
    | 'PRH-IMG-COLORSPACE-NOT-SRGB'
    | 'PRH-IMG-PNG-EXPECTED-JPEG'
    | 'PRH-IMG-JPEG-QUALITY-SUSPECT',
  location: string,
  detail = '',
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location}${detail}`,
    suggestion: suggestionFor(code),
    location,
  };
}

function suggestionFor(code: string): string {
  switch (code) {
    case 'PRH-IMG-CAPTURE-SIZE-WRONG':
      return 'Re-export the image at the canonical capture size for its CSS class (Technical Guide §11). If the class is wrong for the content, change the class instead.';
    case 'PRH-IMG-DPI-TOO-LOW':
      return 'Re-export from the original at ≥ 300dpi. Keep the embedded density metadata; some pipelines strip EXIF, which would suppress this finding entirely.';
    case 'PRH-IMG-COLORSPACE-NOT-SRGB':
      return 'Convert to sRGB in your image-prep pipeline (ICC profile assignment or colour-space conversion as appropriate).';
    case 'PRH-IMG-PNG-EXPECTED-JPEG':
      return 'Re-encode this image as PNG-8 — line drawings, schematics and text-replacement glyphs compress dramatically better with a small palette and avoid JPEG compression artefacts on hard edges.';
    case 'PRH-IMG-JPEG-QUALITY-SUSPECT':
      return 'Re-encode at JPEG quality 8 (NOT 9 / 10 / "max"). Cover images are exempt; reduce non-cover quality to keep the EPUB compact.';
    default:
      return '';
  }
}
