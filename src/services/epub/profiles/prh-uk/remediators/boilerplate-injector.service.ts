/**
 * PRH UK copyright-page boilerplate injector (P5/PR1).
 *
 * Two-phase API:
 *
 *   1. `buildBoilerplateDraft(jobId)` reads the persisted audit
 *      result, identifies the detected imprint, pulls metadata from
 *      the OPF, and returns a `BoilerplateDraft` listing every
 *      missing-boilerplate snippet the operator can choose to inject.
 *      Snippets with `__MISSING_*__` placeholders flag fields the
 *      operator must fill in before applying.
 *
 *   2. `applyBoilerplate(jobId, approval)` accepts the operator's
 *      approved snippet list (optionally with edited HTML where the
 *      operator filled in missing fields) and writes the snippets
 *      into the copyright XHTML, returning the modified EPUB buffer.
 *      The buffer is persisted via the existing remediated-file
 *      storage pipeline.
 *
 * Imprint-gated: only runs on PRH-UK jobs at medium-or-high
 * confidence. Vintage uses its bespoke template; adult imprints use
 * the adult template; Puffin/Ladybird use the children's template.
 */

import prisma from '../../../../../lib/prisma';
import AdmZip from 'adm-zip';
import { logger } from '../../../../../lib/logger';
import { fileStorageService } from '../../../../storage/file-storage.service';
import { s3Service } from '../../../../s3.service';
import {
  buildBoilerplateSnippets,
  imprintTemplate,
  type BoilerplateMetadata,
  type BoilerplateSnippet,
} from '../imprints/boilerplate-templates';
import type { PrhImprint } from '../../types';

export interface BoilerplateDraft {
  jobId: string;
  imprint: PrhImprint | null | 'unknown';
  template: 'adult' | 'children' | 'vintage-bespoke';
  /** dc:* metadata pulled from the OPF. Operator can override missing fields. */
  metadata: BoilerplateMetadata;
  /**
   * Snippets the operator can choose to apply. Filtered to the codes
   * the validator actually flagged on this job — we don't propose
   * boilerplate the EPUB already has.
   */
  snippets: BoilerplateSnippet[];
  /**
   * True when no missing-boilerplate codes are outstanding — the
   * EPUB's copyright page is already compliant per the imprint's
   * rules. UI can display "nothing to inject" state.
   */
  copyrightAlreadyCompliant: boolean;
}

export interface BoilerplateApproval {
  /** Codes the operator approved for injection (subset of draft.snippets[].code). */
  approvedCodes: string[];
  /**
   * Optional per-code HTML override — used when the operator filled
   * in the `__MISSING_*__` placeholders or edited the draft text.
   * When absent, the original draft HTML is injected verbatim.
   */
  overrides?: Record<string, string>;
}

export interface BoilerplateApplyResult {
  jobId: string;
  injectedCodes: string[];
  modifiedFile: string;
  /**
   * Filename of the remediated EPUB stored via fileStorageService.
   * The existing audit/remediation pipeline reads from this path.
   */
  remediatedFileName: string;
}

/**
 * Build a draft of injectable boilerplate snippets for a job.
 *
 * Reads the persisted audit result (`Job.output`) to identify the
 * imprint + the list of outstanding PRH-COPY-* codes; then reads the
 * OPF to populate metadata substitutions.
 */
export async function buildBoilerplateDraft(jobId: string): Promise<BoilerplateDraft> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, output: true, input: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (!job.output) throw new Error(`Job ${jobId} has no audit output — run an audit first`);

  const output = job.output as Record<string, unknown>;
  const profile = (output.publisherProfile && typeof output.publisherProfile === 'object')
    ? (output.publisherProfile as Record<string, unknown>)
    : null;

  if (!profile || profile.publisher !== 'PRH-UK') {
    throw new Error('Boilerplate injector only runs on PRH-UK jobs');
  }
  if (profile.confidence !== 'medium' && profile.confidence !== 'high') {
    throw new Error('Boilerplate injector requires medium-or-high publisher-profile confidence');
  }

  const imprint = (profile.imprint as PrhImprint | 'unknown' | null) ?? null;
  const template = imprintTemplate(imprint);

  const bookTitle = typeof output.bookTitle === 'string' ? output.bookTitle : null;
  const metadata: BoilerplateMetadata = {
    bookTitle,
    // dc:creator / dc:date / dc:identifier aren't on EpubAuditResult
    // yet — read the OPF directly via the buffer below if needed.
    // Fall back to null when missing; the snippet builder surfaces
    // `__MISSING_*__` placeholders for required fields.
    authorName: null,
    isbn: null,
    year: null,
    imprintDisplayName: deriveImprintDisplayName(imprint, template),
    division: deriveDivisionLabel(imprint, template),
  };

  // Read OPF for author / ISBN / year if the buffer is reachable.
  try {
    const buffer = await loadJobEpubBuffer(jobId, jobInputFileName(job.input));
    if (buffer) {
      const opfMetadata = readOpfMetadata(buffer);
      if (opfMetadata.authorName) metadata.authorName = opfMetadata.authorName;
      if (opfMetadata.isbn) metadata.isbn = opfMetadata.isbn;
      if (opfMetadata.year) metadata.year = opfMetadata.year;
      // bookTitle is already populated from output.bookTitle but
      // OPF-derived value is canonical — only overwrite when output
      // didn't provide one.
      if (!metadata.bookTitle && opfMetadata.bookTitle) {
        metadata.bookTitle = opfMetadata.bookTitle;
      }
    }
  } catch (err) {
    logger.warn(`[boilerplate-injector] OPF metadata read failed for job ${jobId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const outstandingCodes = collectOutstandingCopyCodes(output);
  const allSnippets = buildBoilerplateSnippets(template, metadata);
  const snippets = allSnippets.filter((s) => outstandingCodes.has(s.code));

  return {
    jobId,
    imprint,
    template,
    metadata,
    snippets,
    copyrightAlreadyCompliant: snippets.length === 0,
  };
}

/**
 * Apply approved boilerplate snippets to the EPUB's copyright page.
 *
 * For each approved snippet:
 *   - Use the operator override HTML when supplied (operator filled
 *     in `__MISSING_*__` placeholders or edited the draft text).
 *   - Otherwise use the draft HTML as-is.
 *
 * Snippets are appended into the copyright `<section
 * epub:type="copyright-page">` block immediately before the closing
 * `</section>` tag. Insertion order matches the operator's approved
 * list — operators can sequence the insertions by approving in the
 * order they want them to appear.
 *
 * Returns the remediated-file metadata; the caller (controller)
 * decides whether to surface a download URL or trigger a re-audit.
 */
export async function applyBoilerplate(
  jobId: string,
  approval: BoilerplateApproval,
): Promise<BoilerplateApplyResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, input: true, output: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);

  // Re-build the draft so we have authoritative snippet HTML to
  // inject. Cheaper than trusting client-supplied HTML for codes
  // the operator didn't override.
  const draft = await buildBoilerplateDraft(jobId);

  // Preserve the operator's approval ORDER — they may want TDM before
  // EEA, or imprint URL before the address block. Iterating over
  // approval.approvedCodes (not draft.snippets) gives the operator
  // control over insertion sequence. Unknown codes are dropped silently;
  // the count check below catches the all-unknown case.
  const snippetByCode = new Map(draft.snippets.map((s) => [s.code, s]));
  const approvedSnippets: BoilerplateSnippet[] = [];
  for (const code of approval.approvedCodes) {
    const s = snippetByCode.get(code);
    if (s) approvedSnippets.push(s);
  }
  if (approvedSnippets.length === 0) {
    throw new Error('No snippets approved — nothing to apply');
  }

  const buffer = await loadJobEpubBuffer(jobId, jobInputFileName(job.input));
  if (!buffer) throw new Error(`EPUB buffer not found for job ${jobId}`);

  const zip = new AdmZip(buffer);
  const copyrightEntry = findCopyrightEntry(zip);
  if (!copyrightEntry) {
    throw new Error('Copyright page not found in EPUB — use P5/PR2 scaffolder for missing-page case');
  }

  let copyrightXhtml = copyrightEntry.getData().toString('utf-8');

  // Inject each approved snippet immediately before the closing
  // </section> of the copyright-page section. Operator override
  // (if present) takes precedence over the original draft.
  for (const snippet of approvedSnippets) {
    const html = approval.overrides?.[snippet.code] ?? snippet.html;
    copyrightXhtml = insertBeforeCopyrightSectionClose(copyrightXhtml, html);
  }

  copyrightEntry.setData(Buffer.from(copyrightXhtml, 'utf-8'));
  const modifiedBuffer = zip.toBuffer();

  const remediatedFileName = `${jobId}-prh-boilerplate-injected.epub`;
  await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

  logger.info(
    `[boilerplate-injector] applied ${approvedSnippets.length} snippet(s) to job ${jobId}: ${approvedSnippets.map((s) => s.code).join(', ')}`,
  );

  return {
    jobId,
    injectedCodes: approvedSnippets.map((s) => s.code),
    modifiedFile: copyrightEntry.entryName,
    remediatedFileName,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Walk `output.combinedIssues` (an array of audit issues persisted on
 * Job.output) and return the set of PRH-COPY-* codes still flagged.
 * The injector only proposes snippets for codes the validator
 * actually emitted — no point injecting boilerplate the EPUB
 * already has.
 */
function collectOutstandingCopyCodes(output: Record<string, unknown>): Set<string> {
  const issues = Array.isArray(output.combinedIssues) ? output.combinedIssues : [];
  const codes = new Set<string>();
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const code = (issue as Record<string, unknown>).code;
    if (typeof code === 'string' && code.startsWith('PRH-COPY-')) {
      codes.add(code);
    }
  }
  return codes;
}

/**
 * Marketing-name label for the imprint. Used in `[Division]`
 * substitutions on the group statement + address block.
 */
function deriveImprintDisplayName(
  imprint: PrhImprint | null | 'unknown',
  template: 'adult' | 'children' | 'vintage-bespoke',
): string {
  if (imprint === 'penguin') return 'Penguin';
  if (imprint === 'puffin') return 'Puffin';
  if (imprint === 'vintage') return 'Vintage';
  if (imprint === 'pelican') return 'Pelican';
  if (imprint === 'ladybird') return 'Ladybird';
  if (imprint === 'merky') return '#Merky Books';
  if (imprint === 'cornerstone-saga') return 'Cornerstone Saga';
  // Fallback for unknown / null — the adult template is the safest
  // default for non-children's content.
  return template === 'children' ? 'Penguin Random House Children’s' : 'Penguin Random House';
}

/**
 * Division label that appears in the group statement and address
 * block. Adult imprints use their own division name; children's
 * imprints share the "Penguin Random House Children's" division.
 */
function deriveDivisionLabel(
  imprint: PrhImprint | null | 'unknown',
  template: 'adult' | 'children' | 'vintage-bespoke',
): string {
  if (template === 'children') return 'Penguin Random House Children’s';
  if (template === 'vintage-bespoke') return 'Vintage';
  // Adult — division is typically the imprint name + "Books".
  if (imprint === 'penguin') return 'Penguin Books';
  if (imprint === 'pelican') return 'Pelican Books';
  if (imprint === 'merky') return '#Merky Books';
  if (imprint === 'cornerstone-saga') return 'Cornerstone Saga';
  return 'Penguin Random House';
}

/**
 * Best-effort OPF metadata read. Returns null fields rather than
 * throwing so a malformed OPF doesn't kill the draft generation —
 * missing fields surface as `__MISSING_*__` placeholders that the
 * operator fills in.
 */
interface OpfMetadata {
  bookTitle: string | null;
  authorName: string | null;
  isbn: string | null;
  year: string | null;
}
function readOpfMetadata(buffer: Buffer): OpfMetadata {
  const result: OpfMetadata = { bookTitle: null, authorName: null, isbn: null, year: null };
  try {
    const zip = new AdmZip(buffer);
    const containerEntry = zip.getEntry('META-INF/container.xml');
    if (!containerEntry) return result;
    const containerXml = containerEntry.getData().toString('utf-8');
    const opfPathMatch = containerXml.match(/rootfile[^>]+full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const opfPath = opfPathMatch?.[1] ?? opfPathMatch?.[2];
    if (!opfPath) return result;
    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) return result;
    const opf = opfEntry.getData().toString('utf-8');

    result.bookTitle = matchTrimmedDecoded(opf, /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
    result.authorName = matchTrimmedDecoded(opf, /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);

    // dc:identifier is often a URN — try to extract the ISBN-13.
    const idText = matchTrimmedDecoded(opf, /<dc:identifier\b[^>]*>([\s\S]*?)<\/dc:identifier>/i);
    if (idText) {
      const isbnMatch = idText.match(/97[89][\s-]?(?:\d[\s-]?){10}/);
      if (isbnMatch) result.isbn = isbnMatch[0].replace(/\s/g, '');
    }

    // Year from dc:date — accept "2026", "2026-01-15", etc.
    const dateText = matchTrimmedDecoded(opf, /<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i);
    if (dateText) {
      const yearMatch = dateText.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) result.year = yearMatch[0];
    }
  } catch {
    /* malformed zip / OPF — fall through with nulls */
  }
  return result;
}

function matchTrimmedDecoded(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  const decoded = m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  return decoded.length === 0 ? null : decoded;
}

/**
 * Find the copyright-page XHTML inside the zip. Preference order
 * mirrors the validator's findCopyrightXhtml — same logic so the
 * injector always targets the file the validator flagged.
 */
function findCopyrightEntry(zip: AdmZip): AdmZip.IZipEntry | null {
  const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.x?html?$/i.test(e.entryName));
  // 1. body epub:type="copyright-page"
  for (const e of entries) {
    const content = e.getData().toString('utf-8');
    if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b[^"']*["']/i.test(content)) {
      return e;
    }
  }
  // 2. <section epub:type="copyright-page">
  for (const e of entries) {
    const content = e.getData().toString('utf-8');
    if (/<section\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b[^"']*["']/i.test(content)) {
      return e;
    }
  }
  // 3. Filename heuristic.
  for (const e of entries) {
    if (/(?:^|\/)copyright[^/]*\.x?html?$/i.test(e.entryName)) return e;
  }
  return null;
}

/**
 * Insert the snippet immediately before the closing `</section>` of
 * the copyright-page section. Falls back to inserting before
 * `</body>` if the copyright section isn't recognisably structured.
 *
 * Operators preview the result before applying — appending at the
 * end is the conservative choice that doesn't risk reordering the
 * existing content.
 */
function insertBeforeCopyrightSectionClose(xhtml: string, snippet: string): string {
  // First try: insert before </section> on the copyright-page section.
  const sectionRe = /(<section\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b[^"']*["'][\s\S]*?)(<\/section>)/i;
  const sectionMatch = xhtml.match(sectionRe);
  if (sectionMatch) {
    return xhtml.replace(sectionRe, `$1\n${snippet}\n$2`);
  }
  // Fallback: append before </body>.
  const bodyClose = /<\/body>/i;
  if (bodyClose.test(xhtml)) {
    return xhtml.replace(bodyClose, `${snippet}\n</body>`);
  }
  // Last resort: append to the end of the document.
  return `${xhtml}\n${snippet}`;
}

/**
 * Pull the original filename from Job.input JSON. The `input` field
 * is a free-form Json blob; established pattern (acr.service.ts, etc.)
 * is to read either `originalName` or `fileName`. Returns null when
 * neither is present — the caller falls back to remediated-file
 * lookup which doesn't need the original name.
 */
function jobInputFileName(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inputObj = input as { originalName?: unknown; fileName?: unknown };
  if (typeof inputObj.originalName === 'string') return inputObj.originalName;
  if (typeof inputObj.fileName === 'string') return inputObj.fileName;
  return null;
}

/**
 * Load the EPUB buffer for a job. Tries the remediated file first
 * (so successive injector runs build on prior ones), then falls
 * back to the original upload via S3.
 */
async function loadJobEpubBuffer(jobId: string, originalFileName: string | null): Promise<Buffer | null> {
  if (originalFileName) {
    try {
      // Most recent remediated file takes precedence — successive
      // injector runs should compose on top of prior ones.
      const remediated = await fileStorageService.getRemediatedFile(jobId, originalFileName);
      if (remediated) return remediated;
    } catch {
      /* no remediated file yet; fall through */
    }
  }
  try {
    if (originalFileName) {
      // The original file lives in S3 under the job folder.
      const fileKey = `jobs/${jobId}/${originalFileName}`;
      return await s3Service.getFileBuffer(fileKey);
    }
  } catch (err) {
    logger.warn(`[boilerplate-injector] failed to load original EPUB for job ${jobId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  return null;
}
