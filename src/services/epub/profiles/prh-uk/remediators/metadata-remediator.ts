/**
 * PRH UK metadata remediators.
 *
 * Each function takes a `JSZip` (already loaded EPUB), reads the OPF,
 * mutates only the metadata field that PRH requires, and writes the OPF
 * back. Designed to plug into `auto-remediation.service.ts`'s handler
 * registry — each function returns the same `{success, description,
 * before?, after?}` shape the existing handlers use.
 *
 * The fixes are intentionally narrow: each one asserts a single PRH
 * literal string. We deliberately do NOT compose them into a "fix all
 * metadata" mega-fix because the auto-remediation pipeline tracks
 * per-issue success/failure and we want each PRH-META-* code to be
 * independently re-run-able.
 */

import JSZip from 'jszip';
import { logger } from '../../../../../lib/logger';
import { PRH_METADATA_EXPECTED } from '../validators/metadata-validator';

interface ChangeResult {
  success: boolean;
  description: string;
  before?: string;
  after?: string;
}

interface OpfHandle {
  path: string;
  content: string;
}

// ── Public handlers ────────────────────────────────────────────────────────

export async function fixConformsTo(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-CONFORMS-TO', (opf) =>
    upsertMetaProperty(opf, {
      property: 'dcterms:conformsTo',
      value: PRH_METADATA_EXPECTED.conformsTo,
      // Pin id so a11y:certifiedBy can refine #conf.
      idAttr: 'conf',
    }),
  );
}

export async function fixCertifiedBy(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-CERTIFIED-BY', (opf) =>
    upsertMetaProperty(opf, {
      property: 'a11y:certifiedBy',
      value: PRH_METADATA_EXPECTED.certifiedBy,
      idAttr: 'certifier',
      refines: '#conf',
    }),
  );
}

export async function fixCertifierCredential(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-CERTIFIER-CRED', (opf) =>
    upsertMetaProperty(opf, {
      property: 'a11y:certifierCredential',
      value: PRH_METADATA_EXPECTED.certifierCredential,
      refines: '#certifier',
    }),
  );
}

export async function fixCertifierLink(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-CERTIFIER-LINK', (opf) => {
    const linkRe = /<link\b[^>]*\brel\s*=\s*["']a11y:certifierCredential["'][^>]*\/?>/i;
    const expected = `<link rel="a11y:certifierCredential" href="${PRH_METADATA_EXPECTED.certifierLinkHref}"/>`;
    if (linkRe.test(opf)) {
      // Replace any existing link to ensure href is correct.
      const updated = opf.replace(linkRe, expected);
      return updated === opf ? null : updated;
    }
    return insertIntoMetadata(opf, expected);
  });
}

export async function fixTdmReservation(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-TDM-RESERVATION', (opf) => {
    let working = opf;
    let changed = false;

    // 1. Ensure the tdm: prefix is declared on <package> AND maps to the
    //    correct URI (an existing `tdm:` mapped to a wrong URI must be
    //    rewritten — not silently kept).
    const tdmUri = 'http://www.w3.org/ns/tdmrep#';
    const packageOpenRe = /<package\b([^>]*)>/i;
    const pkgMatch = working.match(packageOpenRe);
    if (pkgMatch) {
      const attrs = pkgMatch[1];
      const prefixAttrRe = /\bprefix\s*=\s*(["'])([^"']*)\1/i;
      const existing = attrs.match(prefixAttrRe);
      if (existing) {
        const pairs = parsePrefixPairs(existing[2]);
        const tdmIdx = pairs.findIndex(([k]) => k.toLowerCase() === 'tdm:');
        if (tdmIdx === -1) {
          pairs.push(['tdm:', tdmUri]);
        } else if (pairs[tdmIdx][1] !== tdmUri) {
          pairs[tdmIdx] = ['tdm:', tdmUri];
        } else {
          // Already correct — don't touch.
          // (skip the rewrite to keep the OPF byte-identical)
          // This path leaves `changed` to be set only by step 2.
          // Continue.
        }
        const serialised = pairs.map(([k, v]) => `${k} ${v}`).join(' ');
        if (serialised !== existing[2].trim()) {
          const newAttrs = attrs.replace(prefixAttrRe, `prefix="${serialised}"`);
          working = working.replace(packageOpenRe, `<package${newAttrs}>`);
          changed = true;
        }
      } else {
        // No prefix attribute at all — add one.
        const newAttrs = `${attrs.trimEnd()} prefix="tdm: ${tdmUri}"`;
        working = working.replace(packageOpenRe, `<package${newAttrs}>`);
        changed = true;
      }
    }

    // 2. Ensure the tdm:reservation meta value is "1".
    const next = upsertMetaProperty(working, {
      property: 'tdm:reservation',
      value: PRH_METADATA_EXPECTED.tdmReservationValue,
    });
    if (next != null) {
      working = next;
      changed = true;
    }

    return changed ? working : null;
  });
}

export async function fixA11ySummaryUrl(zip: JSZip): Promise<ChangeResult[]> {
  return runFix(zip, 'PRH-META-A11Y-SUMMARY-URL', (opf) => {
    // Find the existing schema:accessibilitySummary meta and append the URL
    // if it doesn't already reference penguin.co.uk/accessibility.
    const re = /(<meta\b[^>]*\bproperty\s*=\s*["']schema:accessibilitySummary["'][^>]*>)([\s\S]*?)(<\/meta>)/i;
    const m = opf.match(re);
    const url = 'https://www.penguin.co.uk/accessibility';
    if (m) {
      const inner = m[2];
      if (inner.toLowerCase().includes('penguin.co.uk/accessibility')) return null;
      const trimmed = inner.trim();
      const sep = trimmed.endsWith('.') ? ' ' : '. ';
      const newInner = `${trimmed}${sep}For more information visit ${url}`;
      return opf.replace(re, `${m[1]}${newInner}${m[3]}`);
    }
    // No existing meta — insert a minimal one.
    const inserted = insertIntoMetadata(
      opf,
      `<meta property="schema:accessibilitySummary">For more information visit ${url}</meta>`,
    );
    return inserted;
  });
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Skeleton that reads the OPF, applies the supplied transform, writes it back
 * if it changed, and returns a uniform `ChangeResult[]`.
 */
async function runFix(
  zip: JSZip,
  code: string,
  transform: (opfContent: string) => string | null | Promise<string | null>,
): Promise<ChangeResult[]> {
  const opf = await loadOpf(zip);
  if (!opf) {
    return [
      {
        success: false,
        description: `${code}: OPF not found in EPUB`,
      },
    ];
  }

  let updated: string | null;
  try {
    updated = await transform(opf.content);
  } catch (err) {
    logger.warn(`[${code}] transform failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return [
      {
        success: false,
        description: `${code}: transform failed (${err instanceof Error ? err.message : 'unknown error'})`,
      },
    ];
  }

  if (!updated || updated === opf.content) {
    return [
      {
        success: true,
        description: `${code}: already compliant; no change`,
      },
    ];
  }

  zip.file(opf.path, updated);
  return [
    {
      success: true,
      description: `${code}: rewrote OPF metadata`,
      before: extractMetadataExcerpt(opf.content),
      after: extractMetadataExcerpt(updated),
    },
  ];
}

async function loadOpf(zip: JSZip): Promise<OpfHandle | null> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) return null;
  const m = containerXml.match(/rootfile[^>]+full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/);
  const opfPath = m?.[1] ?? m?.[2];
  if (!opfPath) return null;
  const content = await zip.file(opfPath)?.async('text');
  if (!content) return null;
  return { path: opfPath, content };
}

interface UpsertOptions {
  property: string;
  value: string;
  /** Optional id attribute on the meta element. */
  idAttr?: string;
  /** Optional refines attribute (#anchor). */
  refines?: string;
}

/**
 * Insert or replace a `<meta property="X">value</meta>` element. Returns
 * the updated OPF on change, or null if no change was needed.
 */
function upsertMetaProperty(opf: string, opts: UpsertOptions): string | null {
  const escaped = opts.property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta\\b[^>]*\\bproperty\\s*=\\s*["']${escaped}["'][^>]*>([\\s\\S]*?)</meta>`,
    'i',
  );
  const desiredAttrs = [`property="${opts.property}"`];
  if (opts.refines) desiredAttrs.push(`refines="${opts.refines}"`);
  if (opts.idAttr) desiredAttrs.push(`id="${opts.idAttr}"`);
  const desiredElement = `<meta ${desiredAttrs.join(' ')}>${opts.value}</meta>`;

  const existing = opf.match(re);
  if (existing) {
    if (existing[1].trim() === opts.value) {
      // Value already matches — but check that the attributes (id/refines)
      // we want are present. Cheap check: if id is requested, ensure it's there.
      const hasId = !opts.idAttr || new RegExp(`\\bid\\s*=\\s*["']${opts.idAttr}["']`, 'i').test(existing[0]);
      const hasRefines =
        !opts.refines || new RegExp(`\\brefines\\s*=\\s*["']${opts.refines}["']`, 'i').test(existing[0]);
      if (hasId && hasRefines) return null;
    }
    return opf.replace(re, desiredElement);
  }

  return insertIntoMetadata(opf, desiredElement);
}

/**
 * Insert a fragment immediately before `</metadata>`. If no metadata block
 * exists, returns null (caller handles).
 */
function insertIntoMetadata(opf: string, fragment: string): string | null {
  const closeRe = /<\/metadata>/i;
  if (!closeRe.test(opf)) return null;
  return opf.replace(closeRe, `  ${fragment}\n</metadata>`);
}

/**
 * Parse the value of a `prefix=` attribute on `<package>` into [name, uri]
 * pairs. The attribute is a space-separated stream of `name: uri` tokens
 * (e.g. `schema: http://schema.org/ tdm: http://www.w3.org/ns/tdmrep#`).
 */
function parsePrefixPairs(prefixValue: string): [string, string][] {
  const tokens = prefixValue.trim().split(/\s+/).filter((t) => t.length > 0);
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    pairs.push([tokens[i], tokens[i + 1]]);
  }
  return pairs;
}

/** Pull out a short excerpt of the metadata block for change-log diffing. */
function extractMetadataExcerpt(opf: string): string {
  const m = opf.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i);
  if (!m) return '<no metadata block>';
  const inner = m[1].replace(/\s+/g, ' ').trim();
  return inner.length > 600 ? inner.slice(0, 600) + '…' : inner;
}
