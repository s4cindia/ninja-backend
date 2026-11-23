# Ninja PDF remediation QC: Karsaklian (9781606497623), findings and code recon

**For:** Claude Code sessions working on `ninja-backend` / `ninja-frontend` **From:** Manual QC in Acrobat Pro \+ PAC 2024, plus a read-through of both repositories **Date:** 2026-11-23 **Repo state read:** `ninja-backend` @ `62a0d04` (merge of PR \#874, 2026-11-23 05:33 IST), `ninja-frontend` @ `489c7f5` (PR \#412) **Deliverable tested:** `Karsaklian_189165_9781606497623_v2026-11-23_1.pdf` (Ninja output) against the InDesign source `Karsaklian_189165_9781606497623.pdf` **QC log (all evidence, per finding):** [https\://claude.ai/artifact/1FTpdS5UfnJ815TfRzac4C](https://claude.ai/artifact/1FTpdS5UfnJ815TfRzac4C) (tabs: Summary, Doc checks, Page plan, Findings F-01 to F-33)

> Note: `ninja-backend/CLAUDE.md` still says development happens in Replit and asks for "Replit prompts". That's out of date: work no longer happens in Replit. Ignore that section, and consider updating CLAUDE.md as part of this work.  
>   
> Companion file: `2026-11-23-ninja-qc-karsaklian-findings.csv` has the full QC log (all 33 findings with page, severity, category, and the Acrobat/PAC evidence for each). This brief is the analysis; the CSV is the evidence.  
>   
> Caveat: I couldn't see runtime logs or confirm which commit was deployed when this file was processed. Root causes below are from reading the code against the actual output file. Each carries a confidence level. Please verify with the job's `remediation-cycle-history` before changing anything.

---

## 1\. Headline numbers

| PAC 2024 (PDF/UA-1) | Source | Ninja output |
| :---- | :---- | :---- |
| Content errors | 210 | 10 |
| Structure-tree errors | **0** | **13** |
| Alternative-description errors | 12 | 1 |
| Metadata \+ settings errors | 2 | 0 |
| **Total errors** | **224** | **24** |
| Warnings | 3 | 106 |

Acrobat Accessibility Checker found: Tab order failed (160 pages), Figures alt text failed (1), Table headers failed (3), List items failed (13). Headings, title and bookmarks "passed", because Acrobat only checks that they exist.

Manual review of all 14 Figure tags: **2 pass, 3 partial, 9 fail.**

**In short:** Ninja removed about 89% of PAC's errors and made real gains: chapter titles became headings, 129 of 156 running heads were artifacted, a TOC with working links was added, captions are now correct, and the Index is now a properly nested list (confirmed in PAC's Screen Reader Preview). But it also **introduced** 13 structure errors that the source didn't have. Its own issue report is **unreliable**: several items show "Applied" when the fix isn't in the file. Its alt text fails on almost every diagram.

---

## 2\. Root-cause themes (fix these first)

### Theme A: Issue report shows stale "Applied" suggestions against the wrong issue (HIGH confidence)

**Symptom:** Ninja's issue list for this job showed eight issues, most "Applied, Auto-approved". At least five don't match the file:

- **\#7** says alt text was applied to Fig 6.1 (p82). The file has none, and Acrobat and PAC both fail it.  
- **\#5 and \#7**: the AI "vision notes" describe two blank grey rectangles. That's the Fig 5.2 box graphic from p74, not Porter's five forces.  
- **\#8** says the p83 Table 6.1 block was relocated. It's still at the end of the tag tree.  
- **\#1** says bookmarks were generated, but the outline still starts at p25.  
- **\#2** proposes the author name as a heading, with a rationale ("imperative phrasing") that fits a different element.  
- **\#3** reports p7 but the fix landed on p4.

**Mechanism:**

1. Validator issue ids are per-run counters, e.g. `reading-order-float-${++this.issueCounter}` (`src/services/pdf/validators/pdf-reading-order-float.validator.ts:65`). There are 25 validators with `issueCounter = 0` resets. After any re-audit, a *different* finding can inherit an old id.  
2. In `ai-analysis.service.ts`, when analysis returns no suggestion for an issue, the code does `if (!suggestion) { skipped++; return; }` (\~L1371). The row already stored under that id is left untouched.  
3. The stale-row prune only deletes ids **not** in the current set (`deleteMany({ issueId: { notIn: currentIssueIds } })`, \~L1517). A reused id survives with its old content and status.  
4. The frontend pairs suggestions to issues purely by `issueId` (`ninja-frontend/src/pages/PdfAuditResultsPage.tsx` \~L1018: `suggestions.forEach((s) => map.set(s.issueId, s))`). `IssueCard.tsx` \~L491 then renders "Applied" from that row.

This fits every mismatch above:

- `BOOKMARK-MISSING-FRONT-MATTER` isn't in `BOOKMARK_CODES` (ai-analysis L363), so it never gets a suggestion of its own. It inherits round 1's `bookmark-1` "bookmark-generate Applied" row.  
- `READING-ORDER-FLOAT-INTERRUPTION-MANUAL` has deliberately no dispatch, so it inherits an earlier auto row.  
- The complex-diagram alt text is guidance-only, so it inherits rows from other images.

**Fix:**

- When a current issue yields no suggestion, delete (or mark superseded) any existing row under that id whose `issueFingerprint` differs from this issue's fingerprint.  
- Better still, make ids stable (derive from the fingerprint).  
- Frontend: only attach a suggestion if `s.issueFingerprint === issue.fingerprint` (or the backend omits mismatches).  
- **Acceptance test:** re-run a job where round N fixes issue X and round N+1 has a different finding at the same counter position. The new finding must show no suggestion, not X's "Applied".

**Related, and needed regardless:** "Applied" should mean *verified in the output*. Add a post-apply read-back for alt text (and other struct writes) that confirms the target element in the saved file carries the new value, before setting `status='applied'`.

### Theme B: Alt text never sees the whole figure (HIGH confidence)

Seven of this book's figures are **vector or raster backgrounds with live text labels on top**. The pipeline has two paths, and each sees only half the figure:

1. **Raster-only vision.** `imageById` → `analyzeAltText` sends the XObject raster, which here is only the decorative background.  
   - That gives "five empty circles connected by clockwise arrows" (Fig 5.1, duplicate tag, F-11).  
   - It gives "light grey cabinet door sample with a darker grey top panel" (the BATNA box, Fig 5.2, F-09).  
   - It gives "Inverted black-and-white portrait…" (author photo, F-13). The photo is a one-channel `/DeviceN [/Black]` JPEG. Its samples are ink amounts, so decoding them as plain grayscale shows an inverted image to the vision model. Convert DeviceN/Separation to a proper colour space (or render the page crop) before sending it to vision.  
2. **Text-only "formula transcript".** For struct-tree Figures (`figure_p{n}_mc{m}`), the code tries `buildFormulaTranscript` (pdf-structure-writer L8648) and `analyzeFormulaTranscriptAltText` (ai-analysis L1647/L2724). Its prompt says the content is *"a small inline mathematical expression"* and that "raised/lowered" means superscript/subscript. The only gate is "no `Do`/`sh`/`EI` in the span": **no size check, no figure-vs-formula check.** Vector diagrams with labels go down this path:  
   - **Fig 7.1** became "Have to 10 subscript 5, Able to, Want to 10 superscript 5…" (F-10). The axis tick labels 5 and 10 were read as sub/superscripts.  
   - Figs 6.2, 9.1 and 5.2 became flat label lists ("Diagram labels reading: …"), losing the quadrants, axes and definitions (F-12, F-30, F-31).  
3. **Complex diagrams go to manual review and then disappear.** `MANUAL_IF_COMPLEX_IMAGE_TYPES = {'chart','diagram'}` (L137) makes Fig 6.1 guidance-only with `requiresManualReview`. The output therefore shipped **with no alt at all** (F-08, the only PAC alt error), while Theme A showed it as Applied.

**Fix:**

- Gate the formula-transcript path to genuinely formula-sized spans (bbox height/width thresholds, or a font/glyph signal) and never for Figures that carry vector paths plus several text runs over a large area.  
- For Figures whose struct element owns text MCIDs or vector content, send vision a **rendered crop of the figure's bbox** (`fallbackToPageRender` already crops via `issue.boundingBox`) together with the extracted text. Raster-only extraction should be used only for pure image Figures.  
- Prompt for spatial meaning: axes, quadrants, flow order, grid cells.  
- If a figure is truly a table (Fig 5.3 3x3 grid, Table 9.1), propose re-tagging it as `/Table` instead of writing alt text.  
- A Figure left without alt because it was routed to manual review must surface as a **blocking open item** on the job, not silently ship.  
- Collapse duplicate Figure tags over one region (Fig 5.1 has two; `duplicate-figure-tiles.ts` exists, but it didn't catch an image-plus-text Figure pair). Artifact or merge the background-raster Figure.  
- **Acceptance:** on this file, all 14 Figures have alt text describing structure. Fig 7.1 contains no "subscript". There is one Figure per figure.

### Theme C: Heading levels and bookmarks are built from intermediate states (MEDIUM-HIGH confidence)

**Output hierarchy:**

- Half-title is H1; title page and Contents are H2.  
- Chapter titles are **H3**, and "CHAPTER 1" is **H4** while "CHAPTER 2"–"CHAPTER 10" and "CONCLUSION" are **H5**, each sitting *above* its H3 title.  
- Sections are H4, sub-sections H5/H6, and one stray H3 sits on p25 (F-04 to F-07).

**How it got there:** three independent mechanical passes, with no document model.

- `analyzeHeadingStyleMismatch` promotes by font-size bands, `ratio >= 2.2 ? 1 : ratio >= 1.8 ? 2 : 3` (ai-analysis L3761). The large chapter-number label "CHAPTER n" qualifies as a heading in its own right.  
- `fixMultipleH1` (writer L1117) demotes every H1 after the first and cascades.  
- `fixHeadingHierarchy` (writer L1022) renames to close gaps.

Across Full-Auto rounds these compound and push everything down.

**Fix:** add a document-level heading planner before any of these run. It should:

- Detect chapter openers: the CN+CT pair on a new recto page, plus the Contents entries, which are already parsed for the TOC.  
- Merge the "CHAPTER n" label into the title heading (or keep it as P).  
- Assign H1 \= chapter / front-matter / back-matter title, H2 \= section, H3 \= subsection.  
- Then let the gap fixer only clean up.

The Contents page is a strong oracle: `toc-entry-extractor.ts` already exists.

**Bookmarks (F-02, F-03).** The outline has 67 entries: exactly the source's 67 tagged headings, never the chapter or front-matter headings. "Definitions from Armstrong and Kotler (2023)" is the only top-level entry, with everything else nested under it. So `generateBookmarksFromHeadings` (writer L6197) ran **once**, mid-pipeline, and was never re-run after later heading changes.

- `BOOKMARK-MISSING-FRONT-MATTER` has no routing (not in `BOOKMARK_CODES`), so the defect the validator *did* detect was never fixed (Theme A then showed it as Applied).

Fix:

- Regenerate the outline as the **last** structural step of every round, from the final heading tree.  
- Route FRONT-MATTER and any "outline doesn't match headings" check to `bookmark-generate`.

**Title text:** bookmark titles drop the space at line breaks ("Mean**R**epositioning", F-03). `resolveRealHeadingInfo` concatenates pdfjs text parts with `join('')`. Insert a space when a part ends a line, i.e. when pdfjs `hasEOL` is set or the y-position changes.

### Theme D: Document title falls back to the file name (HIGH confidence)

The output title is "Karsaklian\_189165\_9781606497623" (F-01).

`deriveAndSetTitle` (pdf-modifier L2268) correctly rejects the source title "9781606497623\_PRINT.indd" via `isFilenameLike`. It then calls `extractFirstH1Text` (pdf-modifier L2305), which reads **only `/ActualText` and `/Alt`**. That's the same limitation already diagnosed and fixed for bookmarks in `resolveRealHeadingInfo` (writer \~L6100 comment, citing this very file). With no ActualText, it returns null, and the code falls back to the file stem.

Two further problems:

- `isFilenameLike` doesn't recognise `Name_123456_9781606497623`, so later rounds treat the bad title as meaningful and never revisit it.  
- At that point the first H1 was "Definitions from Armstrong…" anyway, not the book title.

**Fix:**

- Resolve heading text via the same pdfjs MCID→text path.  
- Prefer the title page's largest text, or the half-title.  
- Extend `isFilenameLike` to catch underscore-joined tokens and ISBN-13 substrings.  
- **Acceptance:** title \= "Become a Marketing Negotiator: Strategic Expertise in the Boardroom and AI-Driven World".

### Theme E: Detection gaps (the audit can't see what PAC and Acrobat see) (HIGH confidence on the gap, MEDIUM on cause)

| Gap | Evidence | Where / why |
| :---- | :---- | :---- |
| **LI nested inside LI** (13, Ninja-introduced; source had 0\) | Lists continued across a page break (p85→86, 129→131, 134→135) have later items nested in the first item's LI. Body paragraphs after a list are absorbed into the last LI (p57, 129, 134; F-19, F-20). | `validateLists` (pdf-structure.validator L555) is layout-based only. Nothing checks struct-tree list legality (LI parent must be L; L children must be LI/Caption/L). `rewrapListItems` handles "LI whose parent isn't L" but only when that issue is raised, which it never is. **The pass that introduced the nesting isn't identified.** Bisect with the job's per-round outputs (remediation-cycle-history). Prime suspects are passes that reparent across page boundaries (reading-order-float relocation, mcid-page-mismatch, reattach fixers). |
| **Tables with no TH** (4.1, 6.1, 10.1; F-14) | Acrobat "Headers failed x3". No table issue in Ninja's report. | The fixer exists and is eligible (`table-header-fix`, ≤6 columns; ai-analysis \~L1700-1800), but no header issue was raised. Each `/Table` here is nested inside a `/_No_paragraph_style_` → `/P` element (F-16), and header cells are role-mapped `TCH1→P`. Check whether the table detector or validator walks into a P-parented Table. Add a struct-native rule: every `/Table` needs at least one TH, and Scope is required when TH sits on both axes (SWOT 6.1 needs row and column headers). |
| **Table tagged as Figure** (Table 9.1, p116; F-15) | Ninja wrote alt text onto it instead. | No figure→table conversion exists. Add a detector: a Figure whose region contains a ruled grid plus aligned text runs, and a caption beginning "Table". |
| **Reading order: Table 6.1 block still detached** (F-24, Critical) | 2nd `<Sect>` under `<Art>`, after the whole book (after p185). PAC's Screen Reader Preview reads the SWOT table right after the About the Author text, then the author photo, then the Index. | Classified as `READING-ORDER-FLOAT-INTERRUPTION-MANUAL`, which has no dispatch by design. Likely trigger: this block's first MCIDs are the page's **running head**, tagged as content (F-28). Its MCID range then straddles the paragraph continuing from p82, so no clean splice point is found. Artifacting the running head first (Theme F) probably turns this into the auto-fixable case. Also add a fallback for MANUAL cases: insert before the first sibling whose MCID range starts after the block's first *non-furniture* MCID. |
| **Tab order** (F-21, minor) | Acrobat fails 160 pages. PAC passes. | `fixTabOrder` (writer L1334) sets `/Tabs /S` only on pages with `/Annots`, which matches PDF/UA. Set it on every page so Acrobat comes up clean for customers. |
| **Link descriptions** (F-33, minor) | PAC: 66 warnings. | Ninja added 67 links (TOC, LoF, URLs), which is good, but only the p4 link got `/Contents`. Set `/Contents` from the link text when creating TOC links. |
| **Artifacts inside tagged content** (F-32) | PAC: 10 errors, on the Fig 5.2 boxes (p74). | Background box graphics are artifact-marked inside the Figure's tagged span. `tagged-content-artifact-split-fix` exists; check why it didn't fire for a Figure span. |
| **Author photo placement** (F-29, minor) | The photo's Figure is a top-level sibling after the misplaced table, outside About the Author. | Same family as F-24. |
| **PDF/X claim kept** (F-18, minor) | Output is PDF 1.7 \+ pdfuaid:1 but still declares `GTS_PDFXVersion PDF/X-1:2001` in Info and XMP. | Strip the PDF/X identifiers when upgrading the version. |

### Theme F: Running heads (partially fixed) (CONFIRMED in PAC Screen Reader Preview; cause MEDIUM confidence)

In the source, the running heads on all 156 pages were half-tagged: fake small caps split the letters between Artifact and Span. Ninja fixed 129 pages. On **27 pages** the running head is now a fully tagged `<Span>` directly under the main `<Story>`: pp 12–14, 17, 19, odd pages 71–93, odd pages 171–179, 182–184 and 188–190 (F-28).

PAC 2024's Screen Reader Preview confirms that it is read in the text flow: "Span Becoming a Marketing Negotiator Span" appears between body paragraphs on printed pp. 51 and 57\. Acrobat Read Out Loud skips it, so don't use Read Out Loud as the test for this.

`header-footer-varying-content.ts` and `pdf-header-footer-content.validator.ts` handle this pattern. The leftovers cluster in short or alternating sections: Description, Introduction, References and Index, plus chapters 5–6 and the Conclusion (where the left and right heads are the same text). That points at the variant thresholds (`MIN_VARIANT_PAGES = 3`, `MIN_VARIANT_CONTIGUITY_RATIO = 0.4`) or the candidate rule excluding these spans. Log `findVaryingHeaderFooterCandidates` output for these pages to see which rule drops them.

---

## 3\. All findings → code map

Severity is as logged in the QC sheet. Conf is how sure I am of the code cause (H/M/L).

| ID | Sev | Finding (short) | Theme / code | Conf |
| :---- | :---- | :---- | :---- | :---- |
| F-01 | Major | Title is file stem | D: `deriveAndSetTitle`, `extractFirstH1Text`, `isFilenameLike` | H |
| F-02 | Major | Bookmarks: no chapters, one root | C: `generateBookmarksFromHeadings` run once; FRONT-MATTER unrouted | M-H |
| F-03 | Minor | Bookmark words joined at line breaks | C: `resolveRealHeadingInfo` `join('')` | M |
| F-04 | Major | "CHAPTER n" tagged H4/H5 above the title | C: heading-style promote bands | M-H |
| F-05 | Minor | p25 section is H3 among H4 siblings | C: compounding passes | M |
| F-06 | Minor | Hierarchy offset by two levels (to H6) | C | M |
| F-07 | Minor | H4 nested in a paragraph (p55) | C / promote writes in place | L |
| F-08 | **Critical** | Fig 6.1 has no alt | B3: complex diagram → manual, shipped silently | H |
| F-09 | Major | "Cabinet door" alt on the BATNA box | B1: raster-only vision on background | H |
| F-10 | Major | Fig 7.1 alt "10 subscript 5" | B2: formula-transcript path | H |
| F-11 | Minor | Duplicate Figure tag on Fig 5.1 | B: duplicate-figure-tiles misses image+text pair | M |
| F-12 | Major | 6.2 / 9.1 / 10.1 alt lists labels only | B2 | H |
| F-13 | Minor | "Inverted" author photo, unnamed | B1: `/DeviceN [/Black]` image decoded as gray, so it looks inverted | H |
| F-14 | **Critical** | No TH in 3 tables | E: header issue never raised | M |
| F-15 | Major | Table 9.1 tagged as Figure | E: no detector | H |
| F-16 | Minor | Table nested in P; source note as last row | E (inherited) | — |
| F-17 | Minor | Run-in em-dash lists still P | inherited; list detector | L |
| F-18 | Minor | PDF/X claim kept | E | H |
| F-19 | Major | 13 LI-in-LI (introduced) | E: undetected; introducing pass unknown | M (gap) / L (cause) |
| F-20 | Minor | Body text inside last LI | same as F-19 | L |
| F-21 | Minor | Tab order (Acrobat only) | E: `fixTabOrder` annotated pages only | H |
| F-22 | **Critical** | Log says alt applied, file has none | A | H |
| F-23 | Major | Alt image/page mix-up in log | A (stale rows) \+ B1 | H |
| F-24 | **Critical** | Table 6.1 read after the whole book | E: MANUAL float, likely caused by F-28 | M |
| F-25 | Minor | Author name proposed as heading (log) | A | H |
| F-26 | Cosmetic | Log page reference wrong | A | H |
| F-27 | Major | Report omits table / list / title / heading defects | E \+ A | H |
| F-28 | Major | 27 running heads tagged as content | F | M |
| F-29 | Minor | Author photo outside its section | E (F-24 family) | M |
| F-30 | Major | Fig 5.2 definitions lost behind alt | B2 | H |
| F-31 | Major | Fig 5.3 (a 3x3 table) as Figure, values lost | B2 / E | H |
| F-32 | Major | 10 artifacts inside tagged content (p74) | E | L |
| F-33 | Minor | 66 links without description | E | H |

---

## 4\. Suggested order of work

1. **Theme A (report integrity).** Small change, and it restores trust in every other number. Add the stale-row test.  
2. **Theme B2 gate \+ B3 blocking manual items.** Stops the worst alt text and the silent no-alt shipments.  
3. **Theme E list legality.** Add a struct-native validator first (it would have caught all 13), then bisect the introducing pass.  
4. **Table headers** (E) and **reading-order MANUAL fallback** (E/F, with running-head artifacting as the likely unlock).  
5. **Theme C heading planner \+ final-pass bookmark regeneration**, and **Theme D title**.  
6. Minor items: Tabs on all pages, link `/Contents`, PDF/X strip, bookmark spacing.

**Regression harness:** keep this book as a golden file. Gate merges on PAC 2024 \= 0 structure-tree errors and ≤ the current 24 errors, plus Acrobat checker List items/Headers/Figures \= pass. A small script should also assert:

- the title string;  
- the bookmark count is at least the number of chapters;  
- no Figure alt contains "subscript" / "superscript" / "cabinet";  
- every `/Table` has TH;  
- no LI has a non-L parent.