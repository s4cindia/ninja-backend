# Prompt 4 — veraPDF / Matterhorn `boundingBox` correlation: design note (DESIGN SPIKE — STOP before coding)

**Created:** 2026-06-20
**Author:** AVR Venkatesa (via Claude Code)
**Status:** Design note for review. **No code written.** Prompt 4 of
`pdf-boundingbox-backend-prompts.md` explicitly says STOP for review before coding.
**Repo in scope (future):** `ninja-backend`

---

## TL;DR

veraPDF failures carry **no coordinates**. The only structured locator is an
optional `pageNumber`. There is currently **no reliable join key** between a
veraPDF failure and one of the parser's positioned elements, because the
comprehensive parser does not index its elements by PDF object number or MCID.

**Recommendation:** do **not** attempt page-only heuristic matching (false
highlights are worse than none). A correct correlation requires a prerequisite
parser change (index positioned elements by object number / MCID) before any
matching code is worth writing. Many headline Matterhorn conditions are
document-level and will never be locatable regardless.

---

## 1. What identifiers does a veraPDF failure expose?

Source: `src/services/pdf/verapdf.service.ts` (`VeraPdfFailure`, MRR parser) and
`src/services/pdf/pdf-audit.service.ts:495-508` (where issues are built).

A `VeraPdfFailure` has exactly:

| Field | Origin (MRR XML) | Reliability for locating |
|---|---|---|
| `ruleId` | `"{specMajor}:{clause}-{testNumber}"` e.g. `"1:6.2-1"` | Identifies the *rule*, not the place. Maps to a Matterhorn condition via `VERAPDF_MATTERHORN_MAP`. |
| `description` | rule description text | Human text only. |
| `pageNumber?` | first check's `location/@_page` (or `@_pageNumber`) | Present for content-level checks; **absent** for document/catalog-level checks. Page granularity only. |
| `context?` | first check's `<context>` string, trimmed to 200 chars | A veraPDF **object path**, e.g. `root/document[0]/pages[1]/contentStream[0]/...`. May embed an object number; occasionally an MCID. **Never a rectangle.** Format is not contractually stable. |

So: **no x/y/width/height anywhere.** Best case we get a page and a path string
that *sometimes* contains an object number or MCID — but only as substrings of an
unstructured, version-dependent `context`.

## 2. Can these be matched to a positioned parser element? How precise?

The parser's positioned elements and their identity keys today:

| Element (type) | Has geometry? | Identity key exposed |
|---|---|---|
| `PdfImage` | yes (`position`, top-left pts) | generated `id` (`image_p1_0`), **no** object number / MCID |
| `PdfTextContent` | yes (`position`) | none (no id, no MCID) |
| `TableInfo` / `LinkInfo` | yes (`position`) | generated `id`, **no** object number |
| `HeadingInfo` | partial (`{x,y}` only) | generated `id`, **no** object number |
| `PdfFormField` | yes (`position`, bottom-left rect) | `name`, **no** object number |
| `PdfStructureNode` (tags) | **no geometry** | `/ID` attribute string, `pageNumber`; **no** object number, **no** position |

**The join problem:** veraPDF's only machine keys are *page* + *(maybe) object
number / MCID buried in `context`*. The parser indexes by *generated string ids*
and *position* — it captures **neither** the source PDF object number **nor** MCID
for any element. There is therefore **no shared key** to join on.

- Matching by **page only** → 1-to-many (often dozens of elements per page). Useless
  for a precise highlight; high false-match rate.
- Matching by **object number** → would be precise, but requires the parser to
  record each element's xref object number first (it does not today) *and* a
  reliable way to extract that number from the `context` string (brittle).
- Matching by **MCID** → also precise in principle (MCID → marked-content →
  positioned text run), but the parser exposes no MCID→element map, and `context`
  rarely surfaces a clean MCID.

Precision achievable **today**: page-level at best → not good enough to draw a box.

## 3. False-match risk and fallback

- Page-only or rule-type heuristics will confidently highlight the **wrong**
  element. A wrong highlight is worse than no highlight: it misdirects the
  remediator and erodes trust in the overlay.
- **Fallback rule (must-have):** leave `boundingBox` unset whenever match
  confidence is anything less than an *exact* object-number or MCID match. Never
  guess. (This mirrors the existing guardrail: "Do NOT fabricate coordinates.")
- Many headline conditions are **inherently non-spatial** (e.g. CP01 tagging,
  CP06 PDF/UA identifier / metadata, CP07 reading order at document level, CP11
  language). These have no single rectangle and must **never** receive a box,
  correlation or not. Only object/content-level failures (a specific figure, a
  specific artifact/annotation) are even candidates.

## 4. Proposed minimal implementation plan (for review — do not start)

**Phase A — Prerequisite: give positioned elements a join key (parser change).**
Capture, per positioned element, the source PDF **object number** (from the xref
during parse) and, where cheaply available, the **MCID** (from marked-content
operators). Without this there is nothing to join on; it is the real blocker, not
the matching code.

**Phase B — Correlation (only after Phase A):**
1. Parse `failure.context` to extract an object number and/or MCID (defensive;
   tolerate format drift; treat as "no key" on any parse failure).
2. Build a `Map<objectNumber, element>` (and `Map<page:mcid, element>`) from the
   Phase-A-indexed elements.
3. On **exact** key match → attach `boundingBox` from `element.position`
   (top-left pts, the same convention Prompts 1-3 use). On no/ambiguous match →
   leave unset.

**Phase C — Verification & honesty:**
- Unit tests: exact-match attaches; page-only / ambiguous does not; document-level
  conditions never get a box.
- Log per-audit match/no-match counts so coverage is observable (no silent caps).
- Frontend "honesty" UX (already suggested in the parent doc): indicate which
  issues are locatable so users aren't surprised that headline conditions don't
  highlight.

**Effort signal:** Phase A is a non-trivial parser change with its own review and
test surface. Recommend treating A and B as **separate PRs**, and confirming the
product value (how many real-world veraPDF failures are object/content-level and
thus locatable) before investing in A.

## 5. Open questions for review

1. Is object-number indexing acceptable scope for the parser, or out of bounds
   for this sprint?
2. Do we have a corpus sample of veraPDF MRR output to measure (a) how often
   `pageNumber` is present and (b) how often `context` contains a parseable
   object number / MCID? That measurement should gate whether Phase A is worth it.
3. Is a page-level "this issue is somewhere on page N" affordance (scroll-to-page,
   no box) an acceptable interim UX instead of correlation?

---

*Decision requested: approve Phase A as a prerequisite PR, or defer veraPDF
correlation and ship the page-level interim UX. No correlation code will be
written until this is resolved.*

---

## Decision (2026-06-20): **Measure first (Phase 0 data gate)**

Chosen path: run a measurement spike before any Phase A / correlation code, so the
build decision is driven by a go/no-go number, not an assumption.

### Phase 0 spike — what to run
1. Run veraPDF across a representative corpus sample (start with the existing test
   PDFs, incl. `BaranBookmarked_IA ISBN 9798765788493.pdf`, plus a spread of
   tagged/untagged docs). Requires `VERAPDF_PATH` set (`veraPdfService.isAvailable()`).
2. For every `VeraPdfFailure`, tally:
   - % with a structured `pageNumber`
   - % whose `context` contains a **parseable object number** (e.g. `\d+ \d+ obj`,
     or veraPDF object-path refs)
   - % whose `context` contains an **MCID**
   - distribution by Matterhorn condition (which conditions are object/content-level
     and thus even candidates vs. document-level non-spatial)
3. Cross-check: for the failures that DO expose an object id / MCID, how many map to
   a positioned element the parser already produces (images/tables/links/text)?

### Go / no-go rule
- **GO** to Phase A (parser object-id/MCID indexing) only if a *worthwhile share* of
  real failures expose a usable key AND map to positioned elements. (Set the
  threshold with the product owner once the numbers are in.)
- **NO-GO** → fall back to the page-level interim UX (scroll-to-page + locatable
  badge); revisit later.

### Deliverable
A short results table (counts + percentages) appended to this note, plus the
recommendation. Implement as a throwaway audit script (e.g.
`scripts/verapdf-locator-audit.ts`) — not production code.

---

## Phase 0 results (2026-06-21) — measured in staging

Ran veraPDF (`ua1 / mrr`) on 6 representative S3 corpus PDFs via an in-VPC ECS
one-shot on the backend task def (`ninja-backend-task:675`, `VERAPDF_PATH` set),
tallying join-key presence per failed `<check>`. Script:
`scripts/verapdf-locator-audit.cjs` (throwaway).

### Headline — the "no join key" assumption was WRONG

| Signal | Share of failed checks | Notes |
|---|---|---|
| **PDF object reference** in context | **99.6%** (28,998 / 29,112) | e.g. `(12013 0 obj PDLinkAnnot)` |
| **Page index** in context | **~100%** | encoded as `pages[46]` (NOT a `page=` attr — see below) |
| **MCID** in context | 16.2% (4,718) | concentrated in content clauses & tagged PDFs |
| object-ref OR mcid OR page | 99.6% | only doc/catalog-level clauses lack any key |

**The context is richly structured.** Real example:
```
root/document[0]/pages[46](218 0 obj PDPage)/annots[0](12013 0 obj PDLinkAnnot)
```
It exposes, for the failing element: the **page index** (`pages[46]`), the **page
object number** (`218 0 obj`), the **element's own object number** (`12013 0 obj`),
AND the **element type** (`PDLinkAnnot`). This is a precise, machine-usable join key.

### Per-PDF and per-clause

| PDF | failed checks | obj-ref | mcid |
|---|---|---|---|
| aaos_pdf | 10,011 ⚠ | 10,007 | 3,181 |
| altman_pdf | 10,005 ⚠ | 10,004 | 0 |
| aulakh_bookmarked | 8,579 | 8,473 | 1,043 |
| 9781284278477_interactive | 0 | 0 | 0 |
| kim_bookmarked_math | 9 | 9 | 0 |
| Adobe_AutoTag_remediated | 508 | 505 | 494 (97%) |

⚠ aaos & altman hit veraPDF `OutOfMemory` (~10k cap) — totals are partial, but the
presence *rates* are robust.

Dominant clauses: `7.1-3` (18,311, content — has obj-ref, 3,394 mcid), `7.2-34`
(3,219), `7.2-21` (2,009), **`7.18.5-2` link annotations missing /Contents (1,718,
100% obj-ref)**, `7.2-30` (666). Only document/catalog-level clauses (`6.2-1`,
`7.2-2`, `7.10-1`, `7.1-10/11`) lack an object ref — ~0.4% of checks, genuinely
non-spatial (correctly never get a box).

### Correction to §1
The earlier note said `pageNumber` is "sometimes present (as a `page=` attribute)."
veraPDF MRR does **not** use a `page=` attribute — the page index is in the context
path as `pages[N]`. Page is effectively **always** recoverable.

### Revised recommendation: **GO on Phase A**, annotation-first

The join key is reliably present, so correlation is feasible — the gating work is
Phase A (parser indexing by PDF object number). Sequence the build by difficulty:

1. **Slice 1 — annotation clauses (links, form widgets), highest ROI.**
   `7.18.5-2` alone is ~1,718 checks. pdfjs annotations already expose both the
   object id (`annotation.id`, e.g. `"12013R"`) AND a `rect` → boundingBox is
   achievable with modest effort: parse the element object number from context,
   match to the pdfjs annotation, convert its rect (bottom-left) to top-left like
   the form validator already does in #415.
2. **Slice 2 — content/MCID clauses** (`7.1-3`, `7.2-34`): needs an MCID→positioned
   content map (harder; MCID present in only ~16%, but that's where the volume is).
3. **Never** box the doc/catalog-level clauses (~0.4%).

Net: the original "probably not worth it" leaned on a false premise. Measuring
first flipped it — annotation correlation is a clear, bounded win and should be the
next PR after Phase A indexing.
