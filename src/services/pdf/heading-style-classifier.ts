/**
 * Heading-Style-Mismatch Classifier -- Shared Detection + Classification Data
 *
 * Single source of truth for "which /P elements in this document are styled
 * heading-like" -- shared by pdf-heading-style-mismatch.validator.ts
 * (detection, unchanged thresholds) and ai-analysis.service.ts's
 * analyzeHeadingStyleMismatch (the new AI classification pass this module
 * was built for). Extracted from the validator's own original walk rather
 * than duplicated, matching this codebase's established convention for a
 * detection function reused by both a validator and a later AI/apply step
 * (see structure-parent-mismatch.ts's own header comment for the same
 * pattern).
 *
 * See the "Heading-Style-Mismatch Classifier Design" doc
 * (https://claude.ai/artifact/4CwarLbLEjpTgALdFgnUBD) for the full design
 * this implements: a cluster-size pre-filter (a handful of same-sized
 * paragraphs reads as heading-like; dozens is a legitimate body-text style
 * variant) plus a same-font-size-elsewhere negative signal, BOTH computed
 * here from data this module already collects -- neither needs a new AI
 * call or new PDF extraction work.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AuditIssue } from '../audit/base-audit.service';
import { ParsedPDF } from './pdf-parser.service';
import {
  buildContentIdBBoxMap,
  type ContentIdFontMap,
  type ContentIdTextMap,
} from '../zone-extractor/tagged-pdf-extractor';
import { logger } from '../../lib/logger';

// See pdf-heading-style-mismatch.validator.ts's own header comment
// ("Threshold rationale") for why each of these was chosen -- unchanged
// from before this module existed, just relocated here as the detection
// walk's new shared home.
export const FONT_SIZE_RATIO_THRESHOLD = 1.3;
export const MAX_HEADING_CANDIDATE_CHARS = 150;
export const MIN_SAMPLE_SIZE = 5;

// See the design doc's "Decisions (confirmed)" section: a font-size band
// used by more than this many /P elements document-wide is treated as a
// legitimate body-text style variant and declined before any AI call is
// spent on it -- the real discriminator the validator's own header comment
// already flagged ("many other /P paragraphs may legitimately share the
// same visual style") but never had a number attached to until now.
export const CLUSTER_SIZE_DECLINE_THRESHOLD = 8;

// Font sizes are compared as "the same band" within this absolute
// point tolerance -- generous enough to treat e.g. 14.0pt and 14.02pt
// (rounding noise from different content runs of nominally the same style)
// as one band, tight enough not to blur together two genuinely different
// styles a few points apart.
const SAME_SIZE_TOLERANCE_PT = 0.3;

export interface HeadingStyleCandidate {
  pageNumber: number;
  /** One representative MCID from this candidate's own aggregated content
   *  IDs -- enough to re-locate the real struct element later via
   *  pdf-structure-writer.service.ts's resolveParagraphElementForMcid,
   *  without this module ever needing pdf-lib access itself. Any MCID
   *  under the same /P resolves to the same ancestor, so "one representative"
   *  is sufficient; this is always the first content ID's MCID found. */
  mcid: number;
  fontSize: number;
  charCount: number;
  textSample: string;
  /** Immediately preceding/following candidate's own text, in document
   *  order across the whole collection (not just same-page) -- real
   *  structural context for the AI classification call, not the isolated
   *  candidate text alone (see the design doc's own risk: an LLM reading
   *  "Become a Marketing Negotiator" in isolation calls almost anything
   *  heading-shaped a heading; surrounding prose is the real discriminator). */
  precedingText: string;
  followingText: string;
}

export interface HeadingStyleCollectionResult {
  /** Every /P candidate found, in document order -- not just the ones that
   *  cross the ratio/length thresholds. computeClusterSize/
   *  hasConfirmedHeadingAtSameSize both need the FULL population, not just
   *  flagged candidates, to judge whether a given size is common. Empty
   *  (not just unflagged) whenever totalCandidateCount is below
   *  MIN_SAMPLE_SIZE -- too thin a sample to trust for anything, same
   *  "bail rather than guess" convention applied to the sample itself. */
  allCandidates: HeadingStyleCandidate[];
  /** The raw /P count found document-wide, independent of MIN_SAMPLE_SIZE --
   *  kept separate from allCandidates.length so a caller can still report
   *  how many were found (diagnostic/metadata) even on a too-thin sample
   *  that allCandidates itself declines to populate. */
  totalCandidateCount: number;
  /** Font sizes of every already-tagged /H1-/H6 element found (RoleMap-
   *  resolved, same as pdfjs already resolves for /P) -- used by
   *  hasConfirmedHeadingAtSameSize. */
  existingHeadingFontSizes: number[];
  /** Same walk as existingHeadingFontSizes, but keeping each element's own
   *  level (1-6) alongside its font size -- used by
   *  findClusterMatchedLevel to assign a promoted /P the level an existing
   *  heading already uses at that size, rather than only being able to
   *  confirm "some heading exists at this size" with no level attached. */
  existingHeadings: Array<{ fontSize: number; level: number }>;
  bodyMedianFontSize: number;
}

// Minimal local typing for pdfjs's own getStructTree() result shape -- same
// convention pdf-heading-style-mismatch.validator.ts's own original walk
// used (see that file's header comment on why this is cast through
// `unknown` rather than importing pdfjs-dist's own StructTreeNode type).
interface StructNode {
  role: string;
  children: (StructNode | StructContent)[];
}

interface StructContent {
  type: string;
  id: string;
}

function isStructContent(child: StructNode | StructContent): child is StructContent {
  return !('role' in child);
}

interface FontTextAggregate {
  maxFont: number;
  texts: string[];
  /** First content ID seen while aggregating this candidate's own subtree
   *  -- its trailing _mc<N> suffix is this candidate's representative MCID
   *  (see tagged-pdf-extractor.ts's own content-ID format, "p{objId}_mc{mcid}"). */
  firstContentId: string | null;
}

const MCID_SUFFIX = /_mc(\d+)$/;

function extractMcid(contentId: string | null): number | null {
  if (!contentId) return null;
  const m = MCID_SUFFIX.exec(contentId);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Walks every page's pdfjs struct tree, collecting (a) every /P candidate
 * (font size, text, representative MCID) and (b) every already-tagged
 * /H1-/H6 element's own font size. One combined walk rather than two
 * separate passes -- both need the exact same page/fontMap/textMap setup.
 */
export async function collectHeadingStyleData(parsedPdf: ParsedPDF): Promise<HeadingStyleCollectionResult> {
  const empty: HeadingStyleCollectionResult = {
    allCandidates: [],
    totalCandidateCount: 0,
    existingHeadingFontSizes: [],
    existingHeadings: [],
    bodyMedianFontSize: 0,
  };

  if (!parsedPdf.structure?.metadata?.isTagged) return empty;
  const pdfjsDoc = parsedPdf.pdfjsDoc;
  if (!pdfjsDoc) return empty;

  const rawCandidates: Array<{ pageNumber: number; fontSize: number; charCount: number; text: string; mcid: number | null }> = [];
  const existingHeadings: Array<{ fontSize: number; level: number }> = [];

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    let structTree: StructNode | null = null;
    let fontMap: ContentIdFontMap;
    let textMap: ContentIdTextMap;
    // Hoisted so it's cleaned up on every exit path (the early `continue`
    // included) -- see text-extractor.service.ts's own fix comment for why
    // (uncleaned pdfjs page data is a real, confirmed OOM contributor).
    let page: Awaited<ReturnType<typeof pdfjsDoc.getPage>> | undefined;
    try {
      page = await pdfjsDoc.getPage(pageNum);
      const tree = await page.getStructTree();
      if (!tree?.children?.length) continue;
      structTree = tree as unknown as StructNode;

      const maps = await buildContentIdBBoxMap(page);
      fontMap = maps.fontMap;
      textMap = maps.textMap;
    } catch (err) {
      logger.debug(`[HeadingStyleClassifier] Could not read page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    } finally {
      page?.cleanup();
    }

    walkForCandidatesAndHeadings(structTree, fontMap, textMap, pageNum, rawCandidates, existingHeadings);
  }

  const existingHeadingFontSizes = existingHeadings.map((h) => h.fontSize);

  if (rawCandidates.length < MIN_SAMPLE_SIZE) {
    logger.info(`[HeadingStyleClassifier] Only ${rawCandidates.length} /P element(s) found -- too few for a reliable body-text median`);
    return { allCandidates: [], totalCandidateCount: rawCandidates.length, existingHeadingFontSizes, existingHeadings, bodyMedianFontSize: 0 };
  }

  const bodyMedianFontSize = median(rawCandidates.map((c) => c.fontSize).filter((s) => s > 0));

  const allCandidates: HeadingStyleCandidate[] = rawCandidates.map((c, i) => ({
    pageNumber: c.pageNumber,
    mcid: c.mcid ?? -1,
    fontSize: c.fontSize,
    charCount: c.charCount,
    textSample: c.text.slice(0, 120),
    precedingText: i > 0 ? rawCandidates[i - 1].text.slice(0, 200) : '',
    followingText: i < rawCandidates.length - 1 ? rawCandidates[i + 1].text.slice(0, 200) : '',
  }));

  return { allCandidates, totalCandidateCount: rawCandidates.length, existingHeadingFontSizes, existingHeadings, bodyMedianFontSize };
}

function walkForCandidatesAndHeadings(
  node: StructNode,
  fontMap: ContentIdFontMap,
  textMap: ContentIdTextMap,
  pageNumber: number,
  outCandidates: Array<{ pageNumber: number; fontSize: number; charCount: number; text: string; mcid: number | null }>,
  outHeadings: Array<{ fontSize: number; level: number }>,
): void {
  for (const child of node.children ?? []) {
    if (isStructContent(child)) continue;
    if (child.role === 'P') {
      const agg: FontTextAggregate = { maxFont: 0, texts: [], firstContentId: null };
      collectContentIds(child, fontMap, textMap, agg);
      const text = agg.texts.join('').trim();
      outCandidates.push({ pageNumber, fontSize: agg.maxFont, charCount: text.length, text, mcid: extractMcid(agg.firstContentId) });
      // /P elements aren't nested inside each other (PDF32000-1:2008
      // §14.8.4.3) -- don't also recurse looking for a nested candidate.
      continue;
    }
    const headingMatch = /^H([1-6])$/.exec(child.role);
    if (headingMatch) {
      const agg: FontTextAggregate = { maxFont: 0, texts: [], firstContentId: null };
      collectContentIds(child, fontMap, textMap, agg);
      if (agg.maxFont > 0) outHeadings.push({ fontSize: agg.maxFont, level: parseInt(headingMatch[1], 10) });
      // A real heading CAN contain further structure in principle, but this
      // collection only needs its font size and level -- same "don't
      // recurse further" reasoning as the /P branch above.
      continue;
    }
    walkForCandidatesAndHeadings(child, fontMap, textMap, pageNumber, outCandidates, outHeadings);
  }
}

function collectContentIds(node: StructNode, fontMap: ContentIdFontMap, textMap: ContentIdTextMap, agg: FontTextAggregate): void {
  for (const child of node.children ?? []) {
    if (isStructContent(child)) {
      if (agg.firstContentId === null) agg.firstContentId = child.id;
      const size = fontMap.get(child.id);
      if (size && size > agg.maxFont) agg.maxFont = size;
      const texts = textMap.get(child.id);
      if (texts) agg.texts.push(...texts);
    } else {
      collectContentIds(child, fontMap, textMap, agg);
    }
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Pages processed in parallel batches of this size -- same convention as
// text-extractor.service.ts's own font-size collection pass.
const CONTENT_STREAM_PAGE_BATCH_SIZE = 10;

/**
 * Body-text median font size computed directly from the content stream
 * (pdfjs getTextContent()'s own text items), not from tagged /P elements.
 *
 * Real bug, 2026-11-25 (see git log): collectHeadingStyleData()'s own
 * bodyMedianFontSize is 0 for an UNTAGGED document -- it only walks the
 * pdfjs STRUCT TREE, which an untagged PDF doesn't meaningfully have, so
 * there's no /P population to take a median over at all. A caller that
 * reads this from the job's ORIGINAL upload (immutable, to avoid the
 * separate nondeterminism bug this module's own header comment already
 * documents) would get 0 for every untagged-source title, permanently --
 * not just the original instability, but every heading-promote decision
 * on that title landing on the same wrong level every time. This function
 * fixes that by working at the content-stream level, which needs no
 * structure tree at all, so it gives a real body-text median for tagged
 * and untagged sources alike. Deliberately the ONLY median this module's
 * own job-level callers use now (not a fallback only for the untagged
 * case) -- one method, one set of semantics, rather than two code paths
 * that could silently disagree.
 *
 * Uses every text item's own font size (one entry per item, not one per
 * paragraph) -- body text vastly outnumbers headings/captions by raw text
 * volume in virtually any real document, so the median still lands on the
 * body-text size even though it isn't /P-filtered the way
 * collectHeadingStyleData's own candidate population is.
 */
export async function computeContentStreamBodyMedianFontSize(pdfjsDoc: pdfjsLib.PDFDocumentProxy): Promise<number> {
  const allFontSizes: number[] = [];
  const numPages = pdfjsDoc.numPages;

  for (let start = 1; start <= numPages; start += CONTENT_STREAM_PAGE_BATCH_SIZE) {
    const end = Math.min(start + CONTENT_STREAM_PAGE_BATCH_SIZE - 1, numPages);
    const pageNums = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    const textContents = await Promise.all(
      pageNums.map(async (pageNum) => {
        let page: Awaited<ReturnType<typeof pdfjsDoc.getPage>> | undefined;
        try {
          page = await pdfjsDoc.getPage(pageNum);
          return await page.getTextContent();
        } catch (err) {
          logger.debug(`[HeadingStyleClassifier] computeContentStreamBodyMedianFontSize: could not read page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        } finally {
          page?.cleanup();
        }
      })
    );
    for (const textContent of textContents) {
      if (!textContent) continue;
      for (const item of textContent.items) {
        if ('transform' in item && item.transform) {
          const fontSize = Math.abs(item.transform[0]);
          if (fontSize > 0) allFontSizes.push(fontSize);
        }
      }
    }
  }

  return median(allFontSizes);
}

/** How many OTHER candidates (document-wide, flagged or not) share this
 *  font size within SAME_SIZE_TOLERANCE_PT -- the free, already-available
 *  signal the design doc builds the pre-filter around. Includes the
 *  candidate itself in the count (callers compare against
 *  CLUSTER_SIZE_DECLINE_THRESHOLD, which already accounts for this). */
export function computeClusterSize(allCandidates: HeadingStyleCandidate[], fontSize: number): number {
  return allCandidates.filter((c) => Math.abs(c.fontSize - fontSize) <= SAME_SIZE_TOLERANCE_PT).length;
}

/** Whether a CONFIRMED real heading elsewhere in the document already uses
 *  this exact font size -- a negative signal (per the design doc's
 *  confirmed decision to fold this into the AI confidence score, not a
 *  separate hard gate): a same-size /P is more likely a deliberate
 *  stylistic echo of body text than a missed heading when a real heading
 *  at that size already exists. */
export function hasConfirmedHeadingAtSameSize(existingHeadingFontSizes: number[], fontSize: number): boolean {
  return existingHeadingFontSizes.some((s) => Math.abs(s - fontSize) <= SAME_SIZE_TOLERANCE_PT);
}

/**
 * The level a promoted /P should take based on which EXISTING heading's
 * font size it matches, or null if none matches closely enough -- the
 * deterministic alternative to the ratio-cutoff heuristic.
 *
 * Real bug, 2026-11-25 (see git log): the ratio cutoff
 * (fontSize/bodyMedianFontSize, banded at 1.8/2.2) is the SOLE level
 * decision once a /P is confirmed to be a real heading, and it's a sharp
 * step function -- a candidate landing at ratio 1.79 vs 1.81 (noise-level
 * differences in exactly which nearby text run `findCandidateForIssue`
 * re-locates as "the" candidate between two otherwise-identical runs) gets
 * two DIFFERENT levels, which fixHeadingHierarchy's own (correct) gap-
 * closing cascade then amplifies through every heading after it, since
 * closing a genuine skip must compare against the ACTUAL preceding level,
 * not a frozen one (a local-only version of that cascade was tried and
 * rejected: it lets real skips survive, e.g. H1,H4,H4,H4 -> H1,H2,H4,H4,
 * where H2->H4 is itself a Matterhorn 14-003 violation).
 *
 * Preferring the level an existing, already-settled heading uses at this
 * same font size is both more deterministic (an existing heading's level
 * doesn't wobble the way a fresh ratio computation can) and usually more
 * correct (the document's own established hierarchy is better evidence
 * than a fixed global ratio band). Ties (more than one existing level
 * within tolerance) resolve by closest font-size match first, then by
 * smallest level -- both fully deterministic, never by map/array
 * insertion order.
 */
export function findClusterMatchedLevel(
  existingHeadings: Array<{ fontSize: number; level: number }>,
  fontSize: number
): number | null {
  const matches = existingHeadings.filter((h) => Math.abs(h.fontSize - fontSize) <= SAME_SIZE_TOLERANCE_PT);
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const distDiff = Math.abs(a.fontSize - fontSize) - Math.abs(b.fontSize - fontSize);
    if (distDiff !== 0) return distDiff;
    return a.level - b.level;
  });
  return matches[0].level;
}

/** Re-locates the SAME candidate an issue's `element` id refers to, within
 *  a FRESH collection result -- safe within one audit/analysis pass since
 *  both the issue and this collection are derived from parsing the exact
 *  same, unchanged file bytes (ai-analysis.service.ts re-parses the current
 *  file itself rather than sharing the audit step's own in-memory parse).
 *  Matches by (pageNumber, mcid), which buildIssueElement below encodes. */
export function findCandidateForIssue(allCandidates: HeadingStyleCandidate[], issue: AuditIssue): HeadingStyleCandidate | undefined {
  const parsed = parseIssueElement(issue.element);
  if (!parsed) return undefined;
  return allCandidates.find((c) => c.pageNumber === parsed.pageNumber && c.mcid === parsed.mcid);
}

export function buildIssueElement(pageNumber: number, mcid: number): string {
  return `heading-style-mismatch_p${pageNumber}_mc${mcid}`;
}

export function parseIssueElement(element: string | undefined): { pageNumber: number; mcid: number } | null {
  if (!element) return null;
  const m = /^heading-style-mismatch_p(\d+)_mc(-?\d+)$/.exec(element);
  if (!m) return null;
  return { pageNumber: parseInt(m[1], 10), mcid: parseInt(m[2], 10) };
}
