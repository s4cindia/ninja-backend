// Slice 2b of the MATTERHORN-15-001 from-scratch retagger: matches each
// TableCell's source content to real content-stream ranges, then inserts
// new marked-content (BDC/EMC) sequences around them, allocating MCIDs that
// don't collide with a page's existing ones.
//
// Two distinct steps, kept in this one file since they're always used
// together but have different concerns:
//   - matchCellRanges: WHERE in the content stream does a cell's content
//     live? Position-based, reusing locateTextRun (contrast-content-
//     stream.ts) per source TextItem -- deliberately NOT a content-stream
//     text decoder (see matchCellRanges' own doc comment for why).
//   - insertMarkedContentSpans: given a set of already-resolved ranges,
//     allocate MCIDs and splice BDC/EMC around them. Generic -- has no
//     notion of "cell" or table structure; a caller (Slice 2d's skeleton
//     assembly) owns correlating the returned MCIDs back to struct-tree
//     leaves.
//
// This is a distinct operation from pdf-contrast-writer.service.ts's
// content-stream splicing: that module OVERWRITES a color op inside an
// already-located, already-tagged-or-not-relevant run. This module INSERTS
// new marked-content boundaries around content that has none today --
// higher-risk in a different way (getting insertion offsets right when
// nothing is there yet to anchor against, and keeping a whole page's worth
// of insertions consistent when they shift every later offset on that
// page). Reuses decodePageContent/writePageContent/pageContentMcids
// (pdf-content-stream-io.ts) as-is, and the same "collect all insertions,
// apply strictly right-to-left by byte offset" discipline already proven
// twice in this codebase (Seam-C's content-stream.ts, and this file's own
// pdf-contrast-writer.service.ts).

import { PDFDocument } from 'pdf-lib';
import { locateTextRun, TextRunMatch } from './contrast-content-stream';
import { decodePageContent, writePageContent, pageContentMcids } from './pdf-content-stream-io';
import type { TableCell } from './structure-analyzer.service';

// Same threshold pdf-contrast-writer.service.ts applies fixes at -- below
// this, locateTextRun's own match isn't reliable enough to act on. Kept as
// a literal here rather than importing MIN_APPLY_CONFIDENCE from that
// module: that constant is private to a fix-application decision this
// module has nothing to do with (color overwriting), and the two
// thresholds are only coincidentally the same value today -- duplicating a
// primitive constant is preferable to coupling two unrelated features'
// tuning knobs together.
const MIN_APPLY_CONFIDENCE = 0.8;

// locateTextRun's own default.
const DEFAULT_TOLERANCE_PT = 12;

export interface ContentRange {
  start: number;
  end: number;
}

export type CellCoverageStatus = 'full' | 'partial' | 'unresolved';

export interface CellCoverageResult {
  /**
   * 'full': every source TextItem resolved to a high-confidence content-
   * stream match. 'partial': some did, some didn't -- `ranges` covers only
   * the resolved subset; tagging just these ranges is honest (correctly
   * tagged content) but incomplete (some of the cell's visible text stays
   * untagged) -- a caller must decide whether that's acceptable or whether
   * this cell should fall back to a lower-fidelity treatment instead of
   * partial full-fidelity tagging. 'unresolved': nothing matched (or the
   * cell has no source items at all).
   */
  status: CellCoverageStatus;
  /** Merged, deduped content-stream ranges this cell's resolved items map to -- zero or more per cell, since content commonly spans multiple runs. */
  ranges: ContentRange[];
  matchedItemCount: number;
  totalItemCount: number;
}

function isHighConfidence(match: TextRunMatch | null): match is TextRunMatch {
  return !!match && !match.ambiguous && match.confidence >= MIN_APPLY_CONFIDENCE;
}

/**
 * Merges overlapping or touching ranges into their union, sorted by start.
 * Only valid to apply WITHIN a single cell's own ranges (all of which
 * legitimately belong to the same struct-tree leaf) -- never across
 * different cells' ranges, which insertMarkedContentSpans deliberately does
 * NOT do (see its own doc comment): two different cells' content happening
 * to sit adjacent in the content stream must stay two separate MCIDs, not
 * get silently combined into one.
 */
export function mergeRanges(ranges: ContentRange[]): ContentRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ContentRange[] = [{ ...sorted[0] }];
  for (const r of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Resolves a TableCell's content-stream location(s) by matching each of its
 * source TextItems individually via locateTextRun, then merging the
 * resulting ranges.
 *
 * Deliberately position-based, not a content-stream text decoder. An
 * earlier diagnostic (Slice 2a) needed real text decoding, since its whole
 * point was independently verifying whether position-matching could be
 * trusted at all. This function doesn't have that problem: `cell.text` /
 * each TextItem's own text already came from pdfjs's own font/encoding-
 * aware extraction (text-extractor.service.ts) -- trustworthy ground truth,
 * no need to re-derive it from raw content-stream bytes. A general-purpose
 * show-operator-to-text decoder would additionally need real font/encoding
 * resolution (simple encodings, CID/Type0 fonts, /Differences, ToUnicode
 * CMaps) to be correct on arbitrary real PDFs -- a materially larger
 * undertaking than this whole slice, and unnecessary here. Coverage is
 * instead a purely positional proxy: did every TextItem get a confident
 * match, not "does the matched run's decoded text equal cell.text".
 *
 * Known imprecision inherited from locateTextRun: its confidence scoring
 * zeroes out a run with more than one internal fill-color operator
 * (`mixedColor`) -- built for pdf-contrast-writer.service.ts's own
 * recoloring use case, where a multi-color run is genuinely ambiguous
 * about WHICH color to overwrite. That reasoning doesn't apply to tagging
 * (this module never touches color), so a multi-colored cell (e.g. styled
 * math notation) can be scored lower confidence than its position match
 * alone would warrant. Accepted rather than forking locateTextRun's
 * confidence logic -- reuse over reimplementation, per this slice's own
 * scope; revisit if live validation (Slice 2d) shows this meaningfully
 * hurts the match rate.
 */
export function matchCellRanges(
  content: string,
  cell: TableCell,
  tolerancePt = DEFAULT_TOLERANCE_PT
): CellCoverageResult {
  const items = cell.sourceItems ?? [];
  const rawRanges: ContentRange[] = [];
  let matchedItemCount = 0;

  for (const item of items) {
    const anchor = { x: item.position.x, baselineY: item.transform[5] };
    const match = locateTextRun(content, anchor, tolerancePt);
    if (isHighConfidence(match)) {
      matchedItemCount++;
      // lastShowEnd, not end: `end` can extend into trailing graphics-state
      // setup for whatever the NEXT run shows (see TextRunMatch's own doc
      // comment) -- closing this span there would swallow that unrelated
      // setup inside this cell's MCID. Same reasoning this codebase's own
      // spliceColorFix already applies for its restore-color insertion.
      rawRanges.push({ start: match.start, end: match.lastShowEnd });
    }
  }

  const ranges = mergeRanges(rawRanges);
  const status: CellCoverageStatus =
    items.length === 0 || matchedItemCount === 0
      ? 'unresolved'
      : matchedItemCount === items.length
        ? 'full'
        : 'partial';

  return { status, ranges, matchedItemCount, totalItemCount: items.length };
}

export interface RangeInsertionRequest {
  range: ContentRange;
  /**
   * Opaque caller-supplied correlation id (e.g. a cell's `row_column`),
   * returned unchanged on the matching InsertedSpan so a caller can map
   * assigned MCIDs back to whatever it requested tagging for. Not
   * interpreted, validated, or deduplicated by this function.
   */
  id?: string;
}

export interface InsertedSpan {
  mcid: number;
  range: ContentRange;
  id?: string;
}

/**
 * Allocates MCIDs and splices new `/Tag <</MCID n>> BDC ... EMC` marked-
 * content sequences around each requested range, on one page, in one batch.
 *
 * MCID allocation extends the page's existing usage (via pageContentMcids)
 * rather than assuming a blank page -- unlike Seam-C's struct-tree-builder.ts,
 * which always starts at 0 and owns a page's entire MCID space.
 *
 * Deliberately does NOT merge across the input ranges (unlike
 * matchCellRanges, which merges WITHIN one cell's own ranges) -- this
 * function has no notion of which ranges came from the same cell, so
 * merging here could wrongly combine two different cells' adjacent content
 * under one MCID. Instead, any two requests with byte-identical ranges are
 * rejected outright (throws) rather than silently double-wrapped or
 * merged: Slice 2a's diagnostic found zero cross-cell range collisions in
 * a real sample, so this should be rare in practice; if it ever happens,
 * it needs resolution at the caller's level (which cell genuinely owns
 * this content), not a guess here -- matches this codebase's established
 * "bail rather than guess" convention for structure-tree mutation.
 *
 * All insertions for the page are collected first and applied strictly
 * right-to-left by byte offset (same proven discipline as Seam-C's
 * content-stream.ts and pdf-contrast-writer.service.ts's own splice logic)
 * so an earlier insertion's offset never gets invalidated by a later one.
 */
export function insertMarkedContentSpans(
  doc: PDFDocument,
  pageNumber: number,
  requests: RangeInsertionRequest[],
  tag = 'Span'
): InsertedSpan[] {
  if (requests.length === 0) return [];

  const seen = new Set<string>();
  for (const req of requests) {
    const key = `${req.range.start}:${req.range.end}`;
    if (seen.has(key)) {
      throw new Error(
        `insertMarkedContentSpans: two requested ranges are byte-identical (${key}) on page ${pageNumber} -- ` +
        `this must be resolved by the caller (which cell genuinely owns this content), not guessed here.`
      );
    }
    seen.add(key);
  }

  const content = decodePageContent(doc, pageNumber);
  if (content === null) {
    throw new Error(`insertMarkedContentSpans: no readable content stream for page ${pageNumber}`);
  }

  const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
  let nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

  const ordered = [...requests].sort((a, b) => a.range.start - b.range.start);
  const spans: InsertedSpan[] = [];
  const insertions: Array<{ offset: number; text: string }> = [];

  for (const req of ordered) {
    const mcid = nextMcid++;
    insertions.push({ offset: req.range.start, text: `/${tag} <</MCID ${mcid}>> BDC ` });
    insertions.push({ offset: req.range.end, text: ` EMC ` });
    spans.push({ mcid, range: req.range, id: req.id });
  }

  insertions.sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const ins of insertions) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  }

  writePageContent(doc, pageNumber, out);
  return spans;
}
