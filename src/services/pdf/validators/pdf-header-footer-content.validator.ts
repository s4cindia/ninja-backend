/**
 * PDF Header/Footer Tagged-As-Content Validator (DETECT-ONLY)
 *
 * Matterhorn 01-001 ("Artifact is tagged as real content", UA1:7.1-1,
 * confirmed against src/data/matterhorn-1.1.data.ts's own description for
 * that exact condition ID). This is the OPPOSITE direction from
 * pdf-rolemap-integrity.validator.ts's ROLEMAP-*-FLATTENED codes (01-006:
 * a custom tag that DOES resolve to a structure type, just the wrong
 * generic one) -- here, page-repeating decorative text (a running
 * header/title restated every page, or a plain page number) is tagged as
 * real content (e.g. /P or /Span) at all, when it should be a bare
 * /Artifact. Confirmed real via an S4 Carlisle manual QC report: this
 * pollutes reading order and screen-reader output with page furniture a
 * sighted reader's eye naturally skips.
 *
 * DETECT-ONLY, no auto-fix. Reclassifying real content to /Artifact is
 * strictly higher-risk than this session's other RoleMap-retarget fixes --
 * a wrong guess here means assistive technology silently loses real
 * content, not just sees it mis-typed. Flagging for manual author/InDesign
 * review is the honest, safe choice.
 *
 * ── Detection approach ──────────────────────────────────────────────────
 * For every page, every text item (PdfParseResult's own already-extracted
 * PdfTextContent -- no pdfjs operator-list re-parsing needed for this part)
 * whose position falls inside artifact-marker.ts's existing header/footer
 * geometric bands is a candidate. Each candidate's text is normalized
 * (trim -> lowercase -> collapse digit runs to a single '#' placeholder) so
 * a running header with an interleaved page number, or a plain running
 * page number by itself, compares equal across pages. Candidates are then
 * grouped across the WHOLE document by (band, normalized text, position
 * within an ~8pt tolerance on both axes -- a tolerance WINDOW anchored to
 * each group's first-seen position, not a fixed rounding grid, so jitter
 * straddling a grid boundary can't split one real recurring element into
 * two groups). A group is flagged only when it recurs on BOTH >=50% of the
 * document's (audited) pages AND an absolute minimum of >=5 pages -- the
 * dual condition avoids false positives on short documents (where 50% is a
 * tiny absolute count) and avoids flagging genuinely-coincidental short
 * matches on long documents.
 *
 * Each PdfTextContent item (not a reconstructed multi-item line) is its
 * own candidate -- the overwhelmingly common real case of a running
 * header/footer drawn as a single text-show call per logical line is
 * handled whole as a result; a producer that splits one logical header
 * across several separate text-show operators on the same line needs each
 * fragment to independently clear the recurrence threshold. This also
 * keeps a left-aligned running title and a right-aligned page number as
 * two INDEPENDENT candidates (never merged just because they share a
 * baseline), which matters because the page-number-only case below must
 * be caught on its own even when it sits beside a per-chapter-changing
 * title that, by design, will not be.
 *
 * KNOWN, ACCEPTED LIMITATION (shipped anyway, per this session's own prior
 * design investigation -- do not attempt to solve here): a per-chapter
 * running header whose TEXT changes with the chapter (same position, same
 * font, different content per chapter) will NOT be caught by this strict
 * textual match, since each distinct chapter title only recurs across that
 * chapter's own pages, which is very unlikely to reach 50% of the WHOLE
 * document. A plain running page number sitting right next to that same
 * title IS still caught on its own, since it is tracked as an independent
 * candidate (see paragraph above).
 *
 * ── Two adaptations made while implementing this (flagged per design) ───
 *
 * 1. Y-AXIS CONVENTION MISMATCH, easy to get backwards: artifact-marker.ts's
 *    ArtifactRegion/isInArtifactRegion operate in PDF-native BOTTOM-LEFT
 *    origin space (high y = near the top of the page -- see that file's own
 *    header comment). PdfTextContent.position.y (built by
 *    text-extractor.service.ts's processTextItem as
 *    `viewport.height - transform[5]`) is TOP-LEFT origin instead (low y =
 *    near the top of the page) -- the same convention AuditIssue.boundingBox
 *    documents for the image/table/link extractors. Every candidate's y is
 *    converted with `page.height - item.position.y` before calling
 *    artifactMarker.isInArtifactRegion, specifically so this validator can
 *    reuse that module's own band math/constants verbatim rather than
 *    hardcoding a second copy of HEADER_HEIGHT_RATIO/FOOTER_HEIGHT_RATIO.
 *
 * 2. NO EXISTING "already /Artifact" SIGNAL: neither PdfParseResult's
 *    PdfTextContent (pdfjs's getTextContent() extracts visible glyphs
 *    regardless of marked-content tagging -- Artifact-wrapped text comes
 *    back indistinguishable from tagged text) nor artifact-marker.ts itself
 *    (which only computes geometric bands -- it has no notion of existing
 *    tagging at all, confirmed by reading it) exposes this. A small,
 *    self-contained, read-only content-stream scan was added below
 *    (collectArtifactTaggedTexts), reusing two already-exported, already-
 *    used-elsewhere helpers (decodePageContent from pdf-content-stream-io.ts,
 *    tokenize from zone-extractor/seam-c/content-stream.ts) to collect the
 *    set of text shown inside any currently-open /Artifact marked-content
 *    span per page. A candidate whose exact trimmed text is in that set is
 *    excluded -- a deliberately simple TEXT-based correlation (not
 *    position/MCID-based), acceptable for a detect-only, 'minor'-severity
 *    heuristic. Both PDF literal `(...)` and hex `<...>` text-show operands
 *    are decoded (single-byte-per-char only -- correct for WinAnsi/Latin1
 *    text, same scope as strip-marked-content.ts's own decoders; pdf-lib's
 *    own `drawText` with a StandardFonts font hex-encodes its Tj operand,
 *    confirmed via pdf-contrast-artifact-exclusion.test.ts's own comment, so
 *    this had to be handled, not just the literal-string form).
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';
import { artifactMarker } from '../smart-triage/artifact-marker';
import { decodePageContent } from '../pdf-content-stream-io';
import { tokenize } from '../../zone-extractor/seam-c/content-stream';
import { logger } from '../../../lib/logger';

type Token = ReturnType<typeof tokenize>[number];

// A recurring group must appear on at least this fraction of the
// document's (audited) pages...
const MIN_RECURRENCE_RATIO = 0.5;
// ...AND on at least this many pages, absolute -- see this file's own
// header comment for why BOTH conditions are required.
const MIN_RECURRENCE_ABSOLUTE_PAGES = 5;

// Small jitter tolerance (points, both axes) for cross-page position
// grouping -- per-page layout can shift a running element by a point or
// two without it being a different element. Anchored to each group's
// first-seen position (a window, not a rounding grid -- see header
// comment) rather than snapped to a fixed bucket.
const POSITION_TOLERANCE_PT = 8;

const DIGIT_RUN_RE = /\d+/g;
const DIGIT_PLACEHOLDER = '#';

const TEXT_SHOW_OPS = new Set(["Tj", 'TJ', "'", '"']);

function normalizeForComparison(text: string): string {
  return text.trim().toLowerCase().replace(DIGIT_RUN_RE, DIGIT_PLACEHOLDER);
}

/** Minimal PDF literal-string (`(...)`) escape decoder -- see this file's own header comment (adaptation 2). */
function decodeLiteralString(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { out += c; continue; }
    const next = inner[i + 1];
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b') { out += '\b'; i++; }
    else if (next === 'f') { out += '\f'; i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next === '\n' || next === '\r') { i++; } // escaped line break -- not part of the string
    else { out += next; i++; }
  }
  return out;
}

/** Minimal PDF hex-string (`<...>`) decoder, single byte per char (WinAnsi/Latin1 scope) -- see this file's own header comment (adaptation 2). Same logic as strip-marked-content.ts's own (unexported) decodeHexStringLiteral, duplicated per this codebase's established preference for isolated per-feature helpers (see pdf-rolemap-integrity.validator.ts's own doc comment on buildRoleMap). */
function decodeHexString(raw: string): string {
  const hex = raw.slice(1, -1).replace(/\s+/g, '');
  const padded = hex.length % 2 === 0 ? hex : hex + '0';
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Collects the set of distinct text shown by any text-show
 * operator (Tj/TJ/'/") while at least one currently-open marked-content
 * tag on the stack is /Artifact. See this file's own header comment
 * (adaptation 2) for why this exists and its known residual limitation.
 */
function collectArtifactTaggedTexts(content: string): Set<string> {
  const tokens = tokenize(content);
  const texts = new Set<string>();
  const tagStack: boolean[] = []; // true = this open tag is /Artifact
  const operands: Token[] = [];

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    if (op === 'BDC' || op === 'BMC') {
      const tagName = operands.length ? operands[0].v : '';
      tagStack.push(tagName === '/Artifact');
      operands.length = 0;
      continue;
    }
    if (op === 'EMC') {
      tagStack.pop();
      operands.length = 0;
      continue;
    }
    if (op === 'BI') {
      // Inline image: skip the binary payload -- same corruption/misparse
      // hazard (and fix) as every other content-stream scanner in this
      // codebase (see e.g. pdf-artifact-tagger.ts's own handling).
      const idm = /\bID\b/.exec(content.slice(tk.end));
      const from = idm ? tk.end + idm.index + 2 : tk.end;
      const eim = /\sEI\b/.exec(content.slice(from));
      const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
      while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
      operands.length = 0;
      continue;
    }
    if (TEXT_SHOW_OPS.has(op)) {
      if (tagStack.some(Boolean)) {
        const strOperands = operands.filter((o) => o.t === 's' || o.t === 'h');
        const text = strOperands
          .map((o) => (o.t === 's' ? decodeLiteralString(o.v) : decodeHexString(o.v)))
          .join('')
          .trim();
        if (text) texts.add(text);
      }
      operands.length = 0;
      continue;
    }
    operands.length = 0;
  }

  return texts;
}

interface CandidateGroup {
  region: 'header' | 'footer';
  normalizedText: string;
  anchorX: number;
  anchorY: number;
  pages: Set<number>;
}

function findOrCreateGroup(
  groups: CandidateGroup[],
  region: 'header' | 'footer',
  normalizedText: string,
  x: number,
  y: number
): CandidateGroup {
  for (const g of groups) {
    if (
      g.region === region &&
      g.normalizedText === normalizedText &&
      Math.abs(g.anchorX - x) <= POSITION_TOLERANCE_PT &&
      Math.abs(g.anchorY - y) <= POSITION_TOLERANCE_PT
    ) {
      return g;
    }
  }
  const g: CandidateGroup = { region, normalizedText, anchorX: x, anchorY: y, pages: new Set() };
  groups.push(g);
  return g;
}

class PdfHeaderFooterContentValidator {
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    const totalPages = parsed.pages.length;
    if (totalPages === 0) return issues;

    // Reuses artifact-marker.ts's own band math/constants verbatim -- see
    // this file's own header comment (adaptation 1) for the Y-axis
    // conversion this requires.
    const regions = artifactMarker.detectArtifactRegions(parsed);

    const pdfLibDoc = parsed.parsedPdf?.pdfLibDoc;
    const artifactTextCache = new Map<number, Set<string>>();
    const getArtifactTaggedTexts = (pageNumber: number): Set<string> => {
      const cached = artifactTextCache.get(pageNumber);
      if (cached) return cached;

      let texts = new Set<string>();
      if (pdfLibDoc) {
        try {
          const content = decodePageContent(pdfLibDoc, pageNumber);
          if (content) texts = collectArtifactTaggedTexts(content);
        } catch (error) {
          logger.warn(
            `[PdfHeaderFooterContentValidator] Failed to scan page ${pageNumber} for existing Artifact tags:`,
            error
          );
        }
      }
      artifactTextCache.set(pageNumber, texts);
      return texts;
    };

    const groups: CandidateGroup[] = [];

    for (const page of parsed.pages) {
      const artifactTexts = getArtifactTaggedTexts(page.pageNumber);

      for (const item of page.content) {
        const trimmed = item.text.trim();
        if (!trimmed) continue;

        // Already marked as Artifact in the content stream -- not this
        // check's concern (it's specifically about TAGGED-as-content items).
        if (artifactTexts.has(trimmed)) continue;

        // Adaptation 1: convert PdfTextContent's top-left-origin y to the
        // bottom-left-origin y artifact-marker.ts expects.
        const yBottomOrigin = page.height - item.position.y;
        const region = artifactMarker.isInArtifactRegion(yBottomOrigin, page.pageNumber, regions);
        if (!region) continue;

        const normalized = normalizeForComparison(trimmed);
        if (!normalized) continue;

        const group = findOrCreateGroup(groups, region.type, normalized, item.position.x, item.position.y);
        group.pages.add(page.pageNumber);
      }
    }

    for (const group of groups) {
      const pageCount = group.pages.size;
      const ratio = pageCount / totalPages;
      if (pageCount < MIN_RECURRENCE_ABSOLUTE_PAGES || ratio < MIN_RECURRENCE_RATIO) continue;

      const isPageNumberPattern = group.normalizedText === DIGIT_PLACEHOLDER;
      const textDescription = isPageNumberPattern ? '[page-number pattern]' : `"${group.normalizedText}"`;
      const percent = Math.round(ratio * 100);
      const sortedPages = [...group.pages].sort((a, b) => a - b);

      issues.push({
        id: `header-footer-content-${++this.issueCounter}`,
        source: 'pdf-header-footer-content',
        severity: 'minor',
        code: 'HEADER-FOOTER-TAGGED-AS-CONTENT',
        message:
          `Recurring ${group.region} text ${textDescription} is tagged as real content on ${pageCount} of ` +
          `${totalPages} pages (${percent}%) instead of being marked as a PDF Artifact -- this pollutes reading ` +
          'order and screen-reader output with page furniture.',
        wcagCriteria: ['1.3.1'],
        location: `Document-wide (${group.region} region, recurs on ${pageCount}/${totalPages} pages)`,
        suggestion:
          `Ask the author or InDesign operator to mark this recurring ${group.region} text as a background/` +
          'decorative Artifact (not real content) in the authoring tool\'s export settings, so assistive ' +
          'technology skips it.',
        category: 'structure',
        element: group.normalizedText,
        context: `Pages: ${sortedPages.join(', ')}`,
        matterhornCheckpoint: '01-001',
        matterhornHow: 'H',
      });
    }

    logger.info(`[PdfHeaderFooterContentValidator] Found ${issues.length} recurring header/footer issue(s)`);
    return issues;
  }
}

export const pdfHeaderFooterContentValidator = new PdfHeaderFooterContentValidator();
