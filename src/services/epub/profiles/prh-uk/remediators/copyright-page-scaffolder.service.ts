/**
 * PRH UK copyright-page scaffolder (P5/PR2).
 *
 * For EPUBs that don't have a copyright page at all, this service
 * composes a full `<section epub:type="copyright-page">` XHTML
 * document from the imprint's template, inserts it into the zip,
 * registers the new file in the manifest + spine, and adds a
 * landmark entry to the nav doc.
 *
 * Two-phase API mirrors the boilerplate-injector:
 *
 *   1. `buildCopyrightPageDraft(jobId)` — composes the full XHTML
 *      from the imprint's boilerplate snippets, returns it for
 *      operator preview. No mutation.
 *
 *   2. `applyCopyrightPage(jobId, approval)` — writes the XHTML
 *      file into the zip, updates manifest/spine/landmarks
 *      atomically (all-or-nothing in memory before save), and
 *      stores the remediated EPUB.
 *
 * Spine insertion: per PRH content-order rules, copyright comes
 * AFTER the title page (or cover when no title page) and BEFORE
 * the first bodymatter entry. We detect bodymatter by walking
 * spine items and reading each XHTML's `<body epub:type="…">`.
 *
 * Imprint-gated like PR1 — PRH-UK at medium-or-high confidence;
 * adult / children / vintage-bespoke template families.
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
  type BoilerplateMissingField,
  type ImprintTemplate,
} from '../imprints/boilerplate-templates';
import type { PrhImprint } from '../../types';

export interface CopyrightPageDraft {
  jobId: string;
  imprint: PrhImprint | null | 'unknown';
  template: ImprintTemplate;
  metadata: BoilerplateMetadata;
  /** Full XHTML document the operator previews and can override. */
  xhtml: string;
  /** Aggregate list of metadata fields with __MISSING_*__ placeholders. */
  missingFields: BoilerplateMissingField[];
  /** Path the new file will be written to (e.g. EPUB/copyright.xhtml). */
  proposedPath: string;
  /** True when the EPUB already has a copyright page — scaffolder is a no-op. */
  copyrightPageAlreadyExists: boolean;
}

export interface CopyrightPageApproval {
  /** Optional operator-edited XHTML override. Defaults to the draft xhtml. */
  xhtmlOverride?: string;
}

export interface CopyrightPageApplyResult {
  jobId: string;
  insertedAtSpineIndex: number;
  newFilePath: string;
  remediatedFileName: string;
}

/**
 * Body-class hint used in the wrapping XHTML — taken from the
 * Branding Guide: adult template uses `copyright_page_left`,
 * children's same, Vintage uses `copyright_page_center`.
 */
function bodyClassForTemplate(template: ImprintTemplate): string {
  return template === 'vintage-bespoke' ? 'copyright_page_center' : 'copyright_page_left';
}

/**
 * Build the full XHTML document. Wraps every boilerplate snippet
 * inside a single `<section epub:type="copyright-page">` and a
 * frontmatter body. Doctype + XML decl included so the file parses
 * the same as other EPUB content.
 */
function composeCopyrightXhtml(
  template: ImprintTemplate,
  metadata: BoilerplateMetadata,
): { xhtml: string; missingFields: BoilerplateMissingField[] } {
  const snippets = buildBoilerplateSnippets(template, metadata);

  // Aggregate missing-field list across all snippets (de-duped).
  const missing: BoilerplateMissingField[] = [];
  for (const s of snippets) {
    for (const f of s.missingFields) {
      if (!missing.includes(f)) missing.push(f);
    }
  }

  const bodyClass = bodyClassForTemplate(template);
  const innerHtml = snippets.map((s) => s.html).join('\n  ');

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      lang="en" xml:lang="en">
<head>
  <title>Copyright</title>
</head>
<body epub:type="frontmatter" class="${bodyClass}">
  <section epub:type="copyright-page">
  ${innerHtml}
  </section>
</body>
</html>
`;

  return { xhtml, missingFields: missing };
}

/**
 * Build the per-job draft. Same metadata-read path as the
 * boilerplate-injector. Doesn't run when the EPUB already has a
 * copyright page — the injector PR1 handles that case.
 */
export async function buildCopyrightPageDraft(jobId: string): Promise<CopyrightPageDraft> {
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
    throw new Error('Copyright-page scaffolder only runs on PRH-UK jobs');
  }
  if (profile.confidence !== 'medium' && profile.confidence !== 'high') {
    throw new Error('Copyright-page scaffolder requires medium-or-high publisher-profile confidence');
  }

  const imprint = (profile.imprint as PrhImprint | 'unknown' | null) ?? null;
  const template = imprintTemplate(imprint);
  const bookTitle = typeof output.bookTitle === 'string' ? output.bookTitle : null;

  const metadata: BoilerplateMetadata = {
    bookTitle,
    authorName: null,
    isbn: null,
    year: null,
    imprintDisplayName: deriveImprintDisplayName(imprint, template),
    division: deriveDivisionLabel(imprint, template),
  };

  let copyrightPageAlreadyExists = false;
  let proposedPath = 'EPUB/copyright.xhtml';

  try {
    const buffer = await loadJobEpubBuffer(jobId, jobInputFileName(job.input));
    if (buffer) {
      const opfMetadata = readOpfMetadata(buffer);
      if (opfMetadata.authorName) metadata.authorName = opfMetadata.authorName;
      if (opfMetadata.isbn) metadata.isbn = opfMetadata.isbn;
      if (opfMetadata.year) metadata.year = opfMetadata.year;
      if (!metadata.bookTitle && opfMetadata.bookTitle) {
        metadata.bookTitle = opfMetadata.bookTitle;
      }

      const zip = new AdmZip(buffer);
      copyrightPageAlreadyExists = hasCopyrightPage(zip);
      proposedPath = derivePathForNewCopyrightFile(zip);
    }
  } catch (err) {
    logger.warn(`[copyright-scaffolder] OPF read failed for job ${jobId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const { xhtml, missingFields } = composeCopyrightXhtml(template, metadata);

  return {
    jobId,
    imprint,
    template,
    metadata,
    xhtml,
    missingFields,
    proposedPath,
    copyrightPageAlreadyExists,
  };
}

/**
 * Apply the scaffolded copyright page to the EPUB. Atomic in
 * memory: builds the full updated zip (file + manifest + spine +
 * landmarks) before writing back. Either all four pieces update or
 * none do.
 */
export async function applyCopyrightPage(
  jobId: string,
  approval: CopyrightPageApproval,
): Promise<CopyrightPageApplyResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, input: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const draft = await buildCopyrightPageDraft(jobId);
  if (draft.copyrightPageAlreadyExists) {
    throw new Error('Copyright page already exists — use the boilerplate injector (PR1) to update it');
  }

  const buffer = await loadJobEpubBuffer(jobId, jobInputFileName(job.input));
  if (!buffer) throw new Error(`EPUB buffer not found for job ${jobId}`);

  const zip = new AdmZip(buffer);

  // Compose the final state in memory before mutating the zip —
  // any failure short-circuits before we touch the file.
  const xhtml = approval.xhtmlOverride ?? draft.xhtml;
  const opfInfo = readOpfPath(zip);
  if (!opfInfo) throw new Error('OPF not found in EPUB — cannot insert copyright page');

  const newManifestItem = `<item id="${manifestIdForPath(draft.proposedPath)}" href="${hrefRelativeToOpf(opfInfo.dir, draft.proposedPath)}" media-type="application/xhtml+xml"/>`;
  const newSpineItemref = `<itemref idref="${manifestIdForPath(draft.proposedPath)}"/>`;

  const updatedOpf = insertCopyrightIntoOpf(
    opfInfo.content,
    newManifestItem,
    newSpineItemref,
    zip,
    opfInfo.dir,
  );
  const updatedNavInfo = updateNavLandmarks(zip, opfInfo, draft.proposedPath);

  const insertedAtSpineIndex = computeInsertedSpineIndex(opfInfo.content, updatedOpf);

  // All planning done — mutate the zip.
  zip.addFile(draft.proposedPath, Buffer.from(xhtml, 'utf-8'));
  const opfEntry = zip.getEntry(opfInfo.path);
  if (opfEntry) opfEntry.setData(Buffer.from(updatedOpf, 'utf-8'));
  if (updatedNavInfo) {
    const navEntry = zip.getEntry(updatedNavInfo.path);
    if (navEntry) navEntry.setData(Buffer.from(updatedNavInfo.content, 'utf-8'));
  }

  const modifiedBuffer = zip.toBuffer();
  const remediatedFileName = `${jobId}-prh-copyright-scaffolded.epub`;
  await fileStorageService.saveRemediatedFile(jobId, remediatedFileName, modifiedBuffer);

  logger.info(`[copyright-scaffolder] inserted copyright page for job ${jobId} at spine index ${insertedAtSpineIndex}`);

  return {
    jobId,
    insertedAtSpineIndex,
    newFilePath: draft.proposedPath,
    remediatedFileName,
  };
}

// ── shared helpers (mostly mirrors of boilerplate-injector's) ────────────

function deriveImprintDisplayName(imprint: PrhImprint | null | 'unknown', template: ImprintTemplate): string {
  if (imprint === 'penguin') return 'Penguin';
  if (imprint === 'puffin') return 'Puffin';
  if (imprint === 'vintage') return 'Vintage';
  if (imprint === 'pelican') return 'Pelican';
  if (imprint === 'ladybird') return 'Ladybird';
  if (imprint === 'merky') return '#Merky Books';
  if (imprint === 'cornerstone-saga') return 'Cornerstone Saga';
  return template === 'children' ? 'Penguin Random House Children’s' : 'Penguin Random House';
}

function deriveDivisionLabel(imprint: PrhImprint | null | 'unknown', template: ImprintTemplate): string {
  if (template === 'children') return 'Penguin Random House Children’s';
  if (template === 'vintage-bespoke') return 'Vintage';
  if (imprint === 'penguin') return 'Penguin Books';
  if (imprint === 'pelican') return 'Pelican Books';
  if (imprint === 'merky') return '#Merky Books';
  if (imprint === 'cornerstone-saga') return 'Cornerstone Saga';
  return 'Penguin Random House';
}

interface OpfInfo {
  path: string;
  /** Directory portion of opf path inside the zip (e.g. "EPUB"). */
  dir: string;
  content: string;
}
function readOpfPath(zip: AdmZip): OpfInfo | null {
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) return null;
  const containerXml = containerEntry.getData().toString('utf-8');
  const m = containerXml.match(/rootfile[^>]+full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  const path = m?.[1] ?? m?.[2];
  if (!path) return null;
  const opfEntry = zip.getEntry(path);
  if (!opfEntry) return null;
  const content = opfEntry.getData().toString('utf-8');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return { path, dir, content };
}

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
    const opfInfo = readOpfPath(zip);
    if (!opfInfo) return result;
    const opf = opfInfo.content;
    result.bookTitle = decoded(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i));
    result.authorName = decoded(opf.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i));
    const idText = decoded(opf.match(/<dc:identifier\b[^>]*>([\s\S]*?)<\/dc:identifier>/i));
    if (idText) {
      const isbnMatch = idText.match(/97[89][\s-]?(?:\d[\s-]?){10}/);
      if (isbnMatch) result.isbn = isbnMatch[0].replace(/\s/g, '');
    }
    const dateText = decoded(opf.match(/<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i));
    if (dateText) {
      const yearMatch = dateText.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) result.year = yearMatch[0];
    }
  } catch {
    /* fall through with nulls */
  }
  return result;
}

function decoded(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  const trimmed = m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  return trimmed.length === 0 ? null : trimmed;
}

function hasCopyrightPage(zip: AdmZip): boolean {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!/\.x?html?$/i.test(entry.entryName)) continue;
    const content = entry.getData().toString('utf-8');
    if (/epub:type\s*=\s*["'][^"']*\bcopyright-page\b/i.test(content)) return true;
    if (/(?:^|\/)copyright[^/]*\.x?html?$/i.test(entry.entryName)) return true;
  }
  return false;
}

/**
 * Pick a non-conflicting path for the new copyright file. Defaults
 * to `<opf-dir>/copyright.xhtml`; if that already exists, appends
 * `_prh` to avoid clobbering. The "already exists" pre-check above
 * usually short-circuits before we reach this, but be defensive.
 */
function derivePathForNewCopyrightFile(zip: AdmZip): string {
  const opfInfo = readOpfPath(zip);
  const dir = opfInfo?.dir ?? 'EPUB';
  const primary = `${dir}/copyright.xhtml`;
  if (!zip.getEntry(primary)) return primary;
  return `${dir}/copyright_prh.xhtml`;
}

function manifestIdForPath(path: string): string {
  const basename = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return basename.replace(/\.x?html?$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'copyright';
}

function hrefRelativeToOpf(opfDir: string, filePath: string): string {
  if (!opfDir) return filePath;
  if (filePath.startsWith(opfDir + '/')) {
    return filePath.slice(opfDir.length + 1);
  }
  return filePath;
}

/**
 * Insert manifest item + spine itemref into the OPF. Spine insertion
 * position: just BEFORE the first bodymatter itemref. When no
 * bodymatter is detected (rare on real EPUBs but possible on
 * skeleton uploads) we append to the end of the spine — better than
 * inserting at an arbitrary position.
 */
function insertCopyrightIntoOpf(
  opf: string,
  newManifestItem: string,
  newSpineItemref: string,
  zip: AdmZip,
  opfDir: string,
): string {
  // Insert into manifest just before </manifest>.
  let updated = opf.replace(
    /<\/manifest>/i,
    `  ${newManifestItem}\n</manifest>`,
  );

  // Insert into spine. Walk itemrefs, find the first whose target
  // file's body epub:type === bodymatter; insert before it.
  const spineMatch = updated.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) return updated; // malformed OPF — leave manifest update in place

  const manifestMap = buildManifestIdToPath(updated, opfDir);
  const refRe = /<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  let firstBodymatterMatch: RegExpExecArray | null = null;
  while ((m = refRe.exec(spineMatch[1])) !== null) {
    const idref = m[1];
    const targetPath = manifestMap.get(idref);
    if (!targetPath) continue;
    const targetEntry = zip.getEntry(targetPath);
    if (!targetEntry) continue;
    const targetContent = targetEntry.getData().toString('utf-8');
    if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bbodymatter\b/i.test(targetContent)) {
      firstBodymatterMatch = m;
      break;
    }
  }

  if (firstBodymatterMatch) {
    // Replace the spine block with the same content but with the new
    // itemref inserted just before the first bodymatter itemref.
    const oldSpineInner = spineMatch[1];
    const matchedRef = firstBodymatterMatch[0];
    const idx = oldSpineInner.indexOf(matchedRef);
    const newSpineInner = oldSpineInner.slice(0, idx) + `  ${newSpineItemref}\n` + oldSpineInner.slice(idx);
    updated = updated.replace(spineMatch[0], spineMatch[0].replace(oldSpineInner, newSpineInner));
  } else {
    updated = updated.replace(/<\/spine>/i, `  ${newSpineItemref}\n</spine>`);
  }

  return updated;
}

function buildManifestIdToPath(opf: string, opfDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const manifestMatch = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return map;
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(manifestMatch[1])) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!idMatch || !hrefMatch) continue;
    const fullPath = opfDir ? `${opfDir}/${hrefMatch[1]}` : hrefMatch[1];
    map.set(idMatch[1], fullPath);
  }
  return map;
}

/**
 * Locate and update the nav doc's landmarks block to include a
 * copyright entry. Returns null when no nav doc is present (the
 * spine update alone is enough; landmarks are nice-to-have).
 */
function updateNavLandmarks(
  zip: AdmZip,
  opfInfo: OpfInfo,
  copyrightPath: string,
): { path: string; content: string } | null {
  const navMatch = opfInfo.content.match(/<item\b[^>]*\bproperties\s*=\s*["'][^"']*\bnav\b[^"']*["'][^>]*>/i);
  if (!navMatch) return null;
  const hrefMatch = navMatch[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
  if (!hrefMatch) return null;
  const navPath = opfInfo.dir ? `${opfInfo.dir}/${hrefMatch[1]}` : hrefMatch[1];
  const navEntry = zip.getEntry(navPath);
  if (!navEntry) return null;
  let nav = navEntry.getData().toString('utf-8');

  // Skip if landmarks already mentions a copyright entry.
  if (/<nav\b[^>]*\bepub:type\s*=\s*["'][^"']*\blandmarks\b[\s\S]*?\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b/i.test(nav)) {
    return { path: navPath, content: nav };
  }

  const landmarksMatch = nav.match(/(<nav\b[^>]*\bepub:type\s*=\s*["'][^"']*\blandmarks\b[\s\S]*?<ol[^>]*>)([\s\S]*?)(<\/ol>[\s\S]*?<\/nav>)/i);
  if (!landmarksMatch) return { path: navPath, content: nav };

  const copyrightHref = hrefRelativeToNav(navPath, copyrightPath, opfInfo.dir);
  const newLi = `<li><a epub:type="copyright-page" href="${copyrightHref}">Copyright</a></li>`;
  nav = nav.replace(
    landmarksMatch[0],
    `${landmarksMatch[1]}${landmarksMatch[2]}\n  ${newLi}\n${landmarksMatch[3]}`,
  );
  return { path: navPath, content: nav };
}

function hrefRelativeToNav(navPath: string, copyrightPath: string, opfDir: string): string {
  // Nav and copyright both inside the same opf-dir on most EPUBs —
  // emit a basename href, which is correct relative to the nav.
  const copyrightBasename = copyrightPath.includes('/') ? copyrightPath.slice(copyrightPath.lastIndexOf('/') + 1) : copyrightPath;
  const navBasename = navPath.includes('/') ? navPath.slice(navPath.lastIndexOf('/') + 1) : navPath;
  // Both in same dir → bare filename is fine.
  if (opfDir && navPath.startsWith(opfDir + '/') && copyrightPath.startsWith(opfDir + '/')) {
    return copyrightBasename;
  }
  // Otherwise fall back to opf-relative href (rare in real EPUBs).
  return copyrightBasename || navBasename;
}

/**
 * Re-derive the spine index where the new copyright itemref
 * landed. Used by the apply result so the FE can highlight the
 * new entry in the spine view.
 */
function computeInsertedSpineIndex(oldOpf: string, newOpf: string): number {
  const oldRefs = countSpineItemrefs(oldOpf);
  const newRefs = countSpineItemrefs(newOpf);
  if (newRefs === oldRefs + 1) {
    // Locate the position of the new copyright itemref by diffing
    // walk — but simpler: find the index of the unique new
    // idref in the new spine. The new idref always starts with
    // "copyright" or contains "copyright" per manifestIdForPath.
    const spineMatch = newOpf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
      const refs = Array.from(spineMatch[1].matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi));
      for (let i = 0; i < refs.length; i += 1) {
        if (refs[i][1].toLowerCase().startsWith('copyright')) return i;
      }
    }
  }
  return -1;
}

function countSpineItemrefs(opf: string): number {
  const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) return 0;
  return (spineMatch[1].match(/<itemref\b/gi) || []).length;
}

function jobInputFileName(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inputObj = input as { originalName?: unknown; fileName?: unknown };
  if (typeof inputObj.originalName === 'string') return inputObj.originalName;
  if (typeof inputObj.fileName === 'string') return inputObj.fileName;
  return null;
}

async function loadJobEpubBuffer(jobId: string, originalFileName: string | null): Promise<Buffer | null> {
  if (originalFileName) {
    try {
      const remediated = await fileStorageService.getRemediatedFile(jobId, originalFileName);
      if (remediated) return remediated;
    } catch {
      /* fall through */
    }
  }
  try {
    if (originalFileName) {
      const fileKey = `jobs/${jobId}/${originalFileName}`;
      return await s3Service.getFileBuffer(fileKey);
    }
  } catch (err) {
    logger.warn(`[copyright-scaffolder] failed to load EPUB for job ${jobId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  return null;
}

// Re-export the composer for unit testing — it's pure and worth
// testing without the full draft pipeline.
export const _internals = { composeCopyrightXhtml, bodyClassForTemplate };
