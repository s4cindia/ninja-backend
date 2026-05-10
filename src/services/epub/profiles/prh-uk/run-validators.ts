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
import type { PrhValidatorIssue, PrhXhtmlFile } from './validators/types';

export async function runPrhUkValidators(buffer: Buffer): Promise<PrhValidatorIssue[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const opf = await readOpf(zip);
    if (!opf) {
      logger.warn('[PRH validators] OPF not found; skipping');
      return [];
    }

    const navDoc = await readNavDoc(zip, opf.path, opf.content);
    const xhtmlFiles = await readAllXhtml(zip);
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

    return [
      ...validatePrhMetadata(opfInput),
      ...validatePrhSpine(opfInput),
      ...validatePrhNav(navInput),
      ...validatePrhPerXhtml(perXhtmlInput),
    ];
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
 */
function resolveOpfRelative(opfPath: string, href: string): string {
  // OPF paths in the zip usually look like `EPUB/package.opf`. The manifest
  // item href is relative to that file's directory. So `nav.xhtml` from
  // `EPUB/package.opf` resolves to `EPUB/nav.xhtml`.
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // Don't normalise `..` segments — uncommon and risky to handle here.
  return dir + href;
}
