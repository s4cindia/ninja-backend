# Backend Findings: Table/Formula Zone Misclassification & Stale pageCount

**Reported by:** Ambai Venkatesa (via Claude Code walkthrough of a live PDF audit)
**Date:** 2026-08-26
**Severity:** Medium - inflates issue counts and wastes reviewer time on a math-heavy document class; not a correctness/data-loss bug.

## Repro job

| Field | Value |
|---|---|
| File | Math_Olszewski_PDF.pdf (50-page-labeled math textbook, 20,958,075 bytes) |
| Job ID | tqjs2HUHQio9ePjRr8VBp-reaudit |
| Report ID | tqjs2HUHQio9ePjRr8VBp |
| Tagger source | seam-c (Seam-C / YOLO auto-tag) |
| Scan level | comprehensive |
| Audit completed | 2026-08-26T08:39:58.662Z |
| Total issues | 1086 |

Analysis below was done by downloading the report JSON from the "Download Report" action on the PDF Audit Results page and inspecting it directly. All counts are reproducible from that file (see Appendix).

---

## Finding 1: Matrix/equation regions are being classified as Tables, not Formulas

### Summary

Of the 59 Tables-category issues on this job, all 59 trace back to just 16 distinct physical regions, clustered on 6 pages (9-14) - the opening of "Chapter 1: Matrices and Systems of Linear Equations." Every one of those 16 regions is a matrix or a worked system-of-equations block, not a data table. None of them should have generated a TABLE-* issue at all.

### Evidence

**1. The detected "table" dimensions are not table-shaped.** Every logged dimension is either very wide-and-short or otherwise implausible for a real data table in this document:

page 11  table_p11_0  -> 11x2
page 12  table_p12_0  -> 4x13
page 12  table_p12_1  -> 5x8
page 13  table_p13_0  -> 6x8
page 13  table_p13_1  -> 2x9
page 13  table_p13_2  -> 5x6
page 13  table_p13_3  -> 2x7
page 13  table_p13_4  -> 4x5
page 14  table_p14_0  -> 3x20
page 14  table_p14_1  -> 2x6
page 14  table_p14_2  -> 4x9
page 14  table_p14_3  -> 3x19
page 14  table_p14_4  -> 5x7
page 14  table_p14_5  -> 5x6

A 3x20 or 3x19 grid (3 rows, 19-20 columns) is a textbook signature of a system of equations or an inline vector expression whose terms got split into cells by a whitespace/alignment-based grid detector - not a data table (real tables in this document class virtually never run 19-20 columns wide).

**2. Page 14 is a clean, self-contained confirmation.** The 6 regions on page 14 line up exactly with the visible content: two-line SOLUTION a./b. blocks, a SCALAR MULTIPLICATION OF VECTORS example, EXAMPLE 3, a DOT PRODUCT OF VECTORS block, and a DEFINITION block containing the dot-product formula - all matrix/vector arithmetic, zero actual tables. Critically, zero Formula-category issues were logged anywhere on page 14 - the classifier didn't produce a mix of formula/table tags on that page, it labeled every one of these regions a table and none a formula.

**3. Table issues don't appear anywhere else in the 414-page document.** All 59 issues (16 regions) sit on pages 9-14 only - precisely the pages where matrices/systems of equations are introduced. If real data tables existed elsewhere in the document, we'd expect table issues scattered more broadly; we don't see that.

### Root cause (frontend-side investigation)

- src/services/zone-extractor/yolo-label-mapper.ts:8-11 - the YOLO zone detector's canonical label set treats "table" and "formula" as two of 11 sibling visual classes, assigned independently per detected region. A boxed, row/column-aligned grid of numbers (a matrix) is visually close to a small data table, and nothing in the mapper disambiguates them.
- src/services/pdf/validators/pdf-table.validator.ts - once a region is tagged /Table in the structure tree, the table validator trusts that tag completely. There is no heuristic here (numeric-density check, cross-reference against sibling Formula tags on the same page, column-count sanity bound, etc.) to catch an implausible table shape before emitting TABLE-ACCESSIBILITY / TABLE-INACCESSIBLE / MATTERHORN-15-002 / TABLE-MISSING-SUMMARY.
- Compare with pdf-formula.validator.ts, which is specifically built to find /Formula elements missing /ActualText - a correctly-tagged matrix on these pages would have hit this validator instead and produced a much more useful (and AI-draftable, see ai-analysis.service.ts:1398-1459) suggestion.

### Secondary observation: duplicate issue emission per region

Each of the 16 misclassified regions is independently flagged by two parallel table checks - an older code path (TABLE-ACCESSIBILITY / TABLE-INACCESSIBLE, category "tables") and a newer one (MATTERHORN-15-002 / TABLE-MISSING-SUMMARY, categories "table-headers" / "table-summary") - producing 3-4 issues per region. This roughly doubles the visible "Tables" issue count independent of the misclassification bug above, and is worth a look regardless of how the classification issue is resolved (16 real regions -> 59 issues is a lot of redundancy for a reviewer to wade through).

### Suggested directions (not prescriptive - backend team's call)

- Improve YOLO training data / negative examples to better separate "matrix-like formula grid" from "data table," if this is a model-quality gap.
- Add a cheap downstream heuristic in pdf-table.validator.ts (or wherever zone type gets finalized) before emitting table issues: flag-for-review (or auto-downgrade to formula) when a "table" region's cells are overwhelmingly numeric/short-token with no header row, especially at implausible aspect ratios like Nx15+.
- Consider cross-referencing against sibling /Formula tags on the same page/region as a sanity check.
- De-duplicate the two parallel table-issue code paths so one region produces one issue set, not two.

---

## Finding 2: pageCount is stale/wrong (50 vs. actual 414 pages)

### Evidence

The report's top-level pageCount field reads 50, and the Audit Results page header displays "50 pages" accordingly. But:

- metadata.pageLabels in the same report contains 414 entries (10 roman-numeral front-matter labels i-x, then 1-404).
- The PDF preview panel's own page navigator independently shows "14 / 414" when viewing page 14 - i.e., the rendering path knows the real count.
- 788 of the 895 Formula issues have pageNumber > 50 (up to 412), which only makes sense if the document actually has ~414 pages, not 50.

So pageCount: 50 is inconsistent with every other page-count signal in the same report (pageLabels.length, the PDF viewer, and the issue pageNumber distribution). This isn't a frontend display bug - the frontend is just rendering the pageCount field as given.

### Suggested direction

Find wherever pageCount gets set on the audit report (likely computed once from a different/earlier source than the page-label extraction or the PDF parse used elsewhere) and make it derive from the same source of truth as pageLabels/the PDF parser, so it can't drift.

---

## Appendix: how to reproduce

The full report JSON (via "Download Report" on the Audit Results page for this job) has everything needed:

const TABLE_CATS = new Set(["tables","table","table-structure","table-headers","table-summary","layout-table"]);
const tableIssues = data.issues.filter(i => TABLE_CATS.has(i.category));
// 59 issues -> group by (pageNumber + boundingBox) to get the 16 distinct regions

data.pageCount                     // 50
data.metadata.pageLabels.length    // 414
Math.max(...data.issues.filter(i => i.category === "formula").map(i => i.pageNumber))  // 412
