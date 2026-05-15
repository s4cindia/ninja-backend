/**
 * Orchestrator for PRH UK validators. Loads the OPF + nav doc + every
 * XHTML file once via JSZip, then runs each validator against the parsed
 * inputs. Returns a flat list of `PrhValidatorIssue` objects for the audit
 * pipeline to translate into `AccessibilityIssue` records.
 *
 * Best-effort: if the EPUB can't be parsed we return an empty list rather
 * than throwing — a validator failure must never break the surrounding
 * audit. Same defensive posture as the publisher-profile detector.
 */

import JSZip from 'jszip';
import { logger } from '../../../../lib/logger';
import { validatePrhMetadata } from './validators/metadata-validator';
import { validatePrhSpine } from './validators/spine-validator';
import { validatePrhNav } from './validators/nav-validator';
import { validatePrhPerXhtml } from './validators/xhtml-validator';
import { validatePrhImages } from './validators/image-validator';
import { validatePrhCopyrightContent } from './validators/copyright-content-validator';
import { validatePrhBrandPage } from './validators/brand-page-validator';
import { validatePrhTitlePage } from './validators/title-page-validator';
import { validatePrhSocials } from './validators/socials-validator';
import { validatePrhContentOrder } from './validators/content-order-validator';
import { validatePrhEpubTypePlacement } from './validators/epub-type-placement-validator';
import { validatePrhDocAriaRoles } from './validators/doc-aria-roles-validator';
import { validatePrhBodyPurity } from './validators/body-purity-validator';
import { validatePrhForbiddenTags } from './validators/forbidden-tags-validator';
import { validatePrhInlineStyles } from './validators/inline-style-validator';
import { validatePrhLayoutTables } from './validators/layout-table-validator';
import { validatePrhFootnoteIdParity } from './validators/footnote-id-parity-validator';
import { validatePrhPageBreakShape } from './validators/page-break-shape-validator';
import { validatePrhInlineLang } from './validators/inline-lang-validator';
import { validatePrhHashtags } from './validators/hashtag-validator';
import { validatePrhAcronyms } from './validators/acronym-validator';
import { validatePrhCssConventions } from './validators/css-conventions-validator';
import { validatePrhFileLayout } from './validators/file-layout-validator';
import { validatePrhImageAssets } from './validators/image-assets-validator';
import { validatePrhContentTypeMarkup } from './validators/content-type-markup-validator';
import { validatePrhMediaMarkup } from './validators/media-markup-validator';
import { validatePrhLongDescriptionInline } from './validators/long-description-validator';
import { getImprintRules } from './imprints';
import sharp from 'sharp';
import type { PublisherProfile } from '../types';
import type {
  PrhValidatorIssue,
  PrhXhtmlFile,
  PrhCssFile,
  PrhManifestEntry,
  PrhImageMetadata,
} from './validators/types';

/**
 * Run all PRH UK validators against an EPUB buffer.
 *
 * @param buffer            The EPUB file as a Buffer.
 * @param publisherProfile  Optional profile from the detector. When
 *                          omitted, all standards-based PRH validators
 *                          (PR1-PR5 from P1) still run; imprint-gated
 *                          validators (P2/PR1+) only run when the
 *                          profile includes a recognised imprint AND
 *                          confidence is `medium` or `high`. The
 *                          confidence gate at the *publisher* level is
 *                          done by the caller in `epub-audit.service.ts`.
 */
export async function runPrhUkValidators(
  buffer: Buffer,
  publisherProfile?: PublisherProfile,
): Promise<PrhValidatorIssue[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const opf = await readOpf(zip);
    if (!opf) {
      logger.warn('[PRH validators] OPF not found; skipping');
      return [];
    }

    const navDoc = await readNavDoc(zip, opf.path, opf.content);
    const xhtmlFiles = await readAllXhtml(zip);
    const cssFiles = await readAllCss(zip, opf.path, opf.content);
    const manifestEntries = await readManifestEntries(zip, opf.path, opf.content);
    const zipPaths = Object.keys(zip.files);
    const requiresNcx = /\<spine\b[^>]*\btoc\s*=\s*["']ncx["']/i.test(opf.content);
    const bookTitle = readDcTitle(opf.content);

    const opfInput = { opfContent: opf.content, opfPath: opf.path };
    const navInput = {
      ...opfInput,
      navContent: navDoc?.content ?? null,
      navPath: navDoc?.path ?? null,
    };
    const perXhtmlInput = {
      ...opfInput,
      xhtmlFiles,
      bookTitle,
    };
    const cssInput = {
      ...perXhtmlInput,
      cssFiles,
    };
    const fileLayoutInput = {
      ...opfInput,
      manifestEntries,
      zipPaths,
      requiresNcx,
    };

    const issues: PrhValidatorIssue[] = [
      ...validatePrhMetadata(opfInput),
      ...validatePrhSpine(opfInput),
      ...validatePrhNav(navInput),
      ...validatePrhPerXhtml(perXhtmlInput),
      ...validatePrhImages(perXhtmlInput),
    ];

    // Publisher-gated P3 validators run when the publisher is PRH-UK
    // AND confidence is medium-or-high. P3 rules are markup-level and
    // apply to every PRH-UK build regardless of imprint — multi-imprint
    // demo docs (PRH Technical Guide / Branding Guide) still get these
    // checks because the markup conventions are imprint-agnostic.
    const isPrhAtMediumConfidence =
      publisherProfile?.publisher === 'PRH-UK'
      && publisherProfile.confidence !== 'low';
    if (isPrhAtMediumConfidence) {
      // Image metadata is read lazily here — `readImageMetadata` runs
      // sharp once per manifested image, so we only pay that cost when
      // the P3 gate is open and `validatePrhImageAssets` will actually
      // consume the result.
      const imageAssetsInput = {
        ...perXhtmlInput,
        images: await readImageMetadata(zip, manifestEntries),
      };
      issues.push(
        ...validatePrhEpubTypePlacement(perXhtmlInput),
        ...validatePrhDocAriaRoles(perXhtmlInput),
        ...validatePrhBodyPurity(perXhtmlInput),
        ...validatePrhForbiddenTags(perXhtmlInput),
        ...validatePrhInlineStyles(perXhtmlInput),
        ...validatePrhLayoutTables(perXhtmlInput),
        ...validatePrhFootnoteIdParity(perXhtmlInput),
        ...validatePrhPageBreakShape(perXhtmlInput),
        ...validatePrhInlineLang(perXhtmlInput),
        ...validatePrhHashtags(perXhtmlInput),
        ...validatePrhAcronyms(perXhtmlInput),
        ...validatePrhCssConventions(cssInput),
        ...validatePrhFileLayout(fileLayoutInput),
        ...validatePrhImageAssets(imageAssetsInput),
        ...validatePrhContentTypeMarkup(perXhtmlInput),
        ...validatePrhMediaMarkup(perXhtmlInput),
        ...validatePrhLongDescriptionInline(perXhtmlInput),
      );
    }

    // Imprint-gated P2 validators run only when we have a recognised
    // imprint (not 'unknown' / null) AND confidence is medium-or-high.
    // Multi-imprint demo docs (PRH Technical Guide / Branding Guide)
    // resolve to 'unknown' and intentionally skip these.
    const imprintRules = publisherProfile
      ? getImprintRules(publisherProfile.imprint)
      : null;
    if (imprintRules && publisherProfile && publisherProfile.confidence !== 'low') {
      const imprintInput = { ...perXhtmlInput, imprintRules };
      issues.push(
        ...validatePrhCopyrightContent(imprintInput),
        ...validatePrhBrandPage(imprintInput),
        ...validatePrhTitlePage(imprintInput),
        ...validatePrhSocials(imprintInput),
        ...validatePrhContentOrder(imprintInput),
      );
    }

    return issues;
  } catch (err) {
    logger.warn(
      `[PRH validators] run failed; returning no issues: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return [];
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function readOpf(zip: JSZip): Promise<{ path: string; content: string } | null> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) return null;
  const m = containerXml.match(/rootfile[^>]+full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/);
  const opfPath = m?.[1] ?? m?.[2];
  if (!opfPath) return null;
  const content = await zip.file(opfPath)?.async('text');
  if (!content) return null;
  return { path: opfPath, content };
}

/**
 * Locate the EPUB 3 nav document. Preference order:
 *   1. The manifest item with `properties="nav"` (canonical EPUB 3 marker).
 *   2. A file whose path matches `nav.xhtml` / `toc.xhtml` (legacy fallback).
 */
async function readNavDoc(
  zip: JSZip,
  opfPath: string,
  opfContent: string,
): Promise<{ path: string; content: string } | null> {
  // 1. properties="nav"
  const manifestMatch = opfContent.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (manifestMatch) {
    const items = manifestMatch[1].matchAll(/<item\b([^>]*)\/?>/gi);
    for (const m of items) {
      const attrs = m[1];
      if (/\bproperties\s*=\s*["'][^"']*\bnav\b[^"']*["']/i.test(attrs)) {
        const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (hrefMatch) {
          const navPath = resolveOpfRelative(opfPath, hrefMatch[1]);
          const content = await zip.file(navPath)?.async('text');
          if (content) return { path: navPath, content };
        }
      }
    }
  }

  // 2. Filename heuristic.
  for (const filePath of Object.keys(zip.files)) {
    if (/(?:^|\/)(nav|toc)\.x?html?$/i.test(filePath)) {
      const content = await zip.file(filePath)?.async('text');
      if (content) return { path: filePath, content };
    }
  }
  return null;
}

/**
 * Cap total pixels for the palette-probe fast path. The PNG-vs-JPEG
 * heuristic only fires below 800px width AND ≤256 distinct colours,
 * so the typical line-drawing is well under this ceiling. Bound to
 * stop a very tall narrow image (e.g. 800×100000) from forcing a
 * multi-megapixel raw decode.
 */
const MAX_PALETTE_PROBE_PIXELS = 800 * 1200;

/**
 * Normalise sharp's `density` field to a trustworthy value or null.
 *
 * sharp returns `density: 72` even for JPEGs that carry no embedded
 * density metadata at all — that's libvips' default, not a signal
 * from the source. We can't distinguish "stripped EXIF" from "EXIF
 * present at 72dpi" given sharp's API alone, so we treat any 72dpi
 * reading as ambiguous and yield null rather than fire a false
 * `PRH-IMG-DPI-TOO-LOW`. Genuine 72dpi sources will be silently
 * accepted; this is an explicit trade-off favouring zero false
 * positives on an advisory rule.
 */
function extractDensity(rawDensity: unknown): number | null {
  if (typeof rawDensity !== 'number' || rawDensity <= 0) return null;
  if (rawDensity === 72) return null;
  return rawDensity;
}

/**
 * Run sharp once per manifested image and build the per-image
 * metadata the image-assets validator consumes. The validator is
 * synchronous + pure; all sharp I/O lives here.
 *
 * Per-image failures are caught locally — a corrupt image or one
 * sharp can't decode produces a `null`-fields entry so the validator
 * simply skips it rather than aborting the whole audit.
 *
 * `colorCount` is intentionally NOT computed for images wider than
 * 800px: the PNG-vs-JPEG heuristic only fires below that width, so
 * computing the palette for a 4000px hero illustration would be
 * wasted work.
 */
async function readImageMetadata(
  zip: JSZip,
  manifestEntries: PrhManifestEntry[],
): Promise<PrhImageMetadata[]> {
  const out: PrhImageMetadata[] = [];
  for (const entry of manifestEntries) {
    if (!entry.mediaType.startsWith('image/')) continue;
    const zipFile = zip.file(entry.path);
    if (!zipFile) continue;
    try {
      const buf = await zipFile.async('nodebuffer');
      const isCover = entry.properties.includes('cover-image');
      const meta = await sharp(buf).metadata();
      let colorCount: number | null = null;
      if (
        entry.mediaType === 'image/jpeg'
        && typeof meta.width === 'number'
        && typeof meta.height === 'number'
        && meta.width <= 800
        // Guardrail: cap total pixels examined to keep palette probing
        // bounded — even within the 800px width gate, a very tall image
        // could otherwise decode a multi-MB raw buffer.
        && meta.width * meta.height <= MAX_PALETTE_PROBE_PIXELS
      ) {
        try {
          // sharp's `stats.channels` doesn't expose distinct colour
          // count directly. Use raw pixels + a Set for small images.
          const { data, info } = await sharp(buf)
            .raw()
            .toBuffer({ resolveWithObject: true });
          const seen = new Set<number>();
          const stride = info.channels;
          for (let i = 0; i + stride <= data.length; i += stride) {
            // Pack RGB(A) into a single 32-bit integer for the Set.
            const r = data[i];
            const g = stride >= 2 ? data[i + 1] : 0;
            const b = stride >= 3 ? data[i + 2] : 0;
            seen.add((r << 16) | (g << 8) | b);
            if (seen.size > 256) break;
          }
          colorCount = seen.size;
        } catch {
          colorCount = null;
        }
      }
      out.push({
        path: entry.path,
        mediaType: entry.mediaType,
        width: typeof meta.width === 'number' ? meta.width : null,
        height: typeof meta.height === 'number' ? meta.height : null,
        density: extractDensity(meta.density),
        colorSpace: typeof meta.space === 'string' ? meta.space : null,
        colorCount,
        sizeBytes: buf.length,
        isCover,
      });
    } catch (err) {
      logger.warn(
        `[PRH image metadata] sharp failed for ${entry.path}; skipping: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
  return out;
}

/**
 * Walk the OPF manifest and resolve every item into a
 * `PrhManifestEntry`. Sizes come from JSZip's already-loaded entry
 * table when available (we use `async('uint8array').then(u => u.length)`
 * because JSZip doesn't expose a stable public sync size accessor;
 * decompression is one-time and cheap on the typical EPUB).
 */
async function readManifestEntries(
  zip: JSZip,
  opfPath: string,
  opfContent: string,
): Promise<PrhManifestEntry[]> {
  const manifestMatch = opfContent.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return [];

  const out: PrhManifestEntry[] = [];
  for (const item of manifestMatch[1].matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = item[1];
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const mediaTypeMatch = attrs.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch || !mediaTypeMatch) continue;
    const propsMatch = attrs.match(/\bproperties\s*=\s*["']([^"']+)["']/i);
    const itemPath = resolveOpfRelative(opfPath, hrefMatch[1]);
    let sizeBytes: number | null = null;
    const zipEntry = zip.file(itemPath);
    if (zipEntry) {
      try {
        const u = await zipEntry.async('uint8array');
        sizeBytes = u.length;
      } catch {
        sizeBytes = null;
      }
    }
    out.push({
      path: itemPath,
      mediaType: mediaTypeMatch[1].toLowerCase(),
      properties: propsMatch ? propsMatch[1].toLowerCase().split(/\s+/).filter(Boolean) : [],
      sizeBytes,
    });
  }
  return out;
}

/**
 * Read every CSS file REFERENCED BY THE MANIFEST and classify each as
 * publisher-owned vs. third-party / vendor. The CSS-conventions
 * validator only enforces class-name rules against publisher-owned
 * stylesheets so vendored utility frameworks (TailwindCSS, Bootstrap)
 * don't false-flag.
 *
 * Manifest-scoped: an EPUB may carry unused source / backup CSS files
 * in the zip that aren't part of the publication. Iterating the zip
 * blindly would produce false-positive findings on those. The
 * manifest is the authoritative list of files that participate in
 * the EPUB at runtime.
 *
 * Classification heuristic:
 *   - publisher-owned: path lives under a `/styles/` (or `/style/` /
 *     `/css/`) directory AND the basename is not one of the well-known
 *     vendor filenames.
 *   - vendor: everything else (including stylesheets under
 *     `/vendor/`, `/lib/`, `/node_modules-style/`, or that match
 *     filenames like `tailwind.css` / `bootstrap.css`).
 */
async function readAllCss(
  zip: JSZip,
  opfPath: string,
  opfContent: string,
): Promise<PrhCssFile[]> {
  const manifestMatch = opfContent.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return [];

  const out: PrhCssFile[] = [];
  for (const item of manifestMatch[1].matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = item[1];
    const mediaTypeMatch = attrs.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i);
    if (!mediaTypeMatch || mediaTypeMatch[1].toLowerCase() !== 'text/css') continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const cssPath = resolveOpfRelative(opfPath, hrefMatch[1]);
    const content = await zip.file(cssPath)?.async('text');
    if (!content) continue;
    out.push({ path: cssPath, content, isPublisherOwned: classifyPublisherOwned(cssPath) });
  }
  return out;
}

function classifyPublisherOwned(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (/(?:^|\/)(?:vendor|lib|third[_-]?party|node_modules)\//.test(lower)) return false;
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const vendorFilenames = [
    'tailwind.css',
    'bootstrap.css',
    'bootstrap.min.css',
    'normalize.css',
    'reset.css',
    'foundation.css',
  ];
  if (vendorFilenames.includes(base)) return false;
  // Default to publisher-owned for anything under a /styles[/]?/ root.
  return /(?:^|\/)(?:styles?|css)\//.test(lower);
}

/**
 * Read every XHTML/HTML file in the zip. We read all of them rather than
 * just spine entries because the per-XHTML rules apply universally — even
 * non-linear pages (long descriptions, footnotes) need lang attributes and
 * sensible <title>s.
 */
async function readAllXhtml(zip: JSZip): Promise<PrhXhtmlFile[]> {
  const out: PrhXhtmlFile[] = [];
  for (const filePath of Object.keys(zip.files)) {
    if (!/\.(x?html?)$/i.test(filePath)) continue;
    const content = await zip.file(filePath)?.async('text');
    if (!content) continue;
    out.push({ path: filePath, content });
  }
  return out;
}

function readDcTitle(opfContent: string): string | null {
  const m = opfContent.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  if (!m) return null;
  const inner = m[1].trim();
  return inner.length === 0 ? null : inner;
}

/**
 * Resolve a manifest href (relative to the OPF directory) into a zip path.
 *
 * The OPF lives in the zip at e.g. `EPUB/package.opf`; manifest item hrefs
 * are relative to that file's directory. We have to normalise `.` and `..`
 * segments because some valid manifests carry hrefs like
 * `../text/nav-doc.xhtml` (when the OPF lives in a sub-directory). Plain
 * concatenation would emit `EPUB/../text/nav-doc.xhtml`, which doesn't
 * exist as a literal zip entry, so the lookup would silently fail.
 */
function resolveOpfRelative(opfPath: string, href: string): string {
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
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
