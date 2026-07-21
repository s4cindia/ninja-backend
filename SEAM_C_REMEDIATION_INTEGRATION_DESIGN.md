# Seam C — Detector-Driven PDF Structure for Remediation (Design Pass)

**Status:** Draft for review — not scheduled
**Date:** 2026-07-21
**Author:** Venkat (with Claude Code)
**Prereq context:** `ZONE_DETECTOR_INTEGRATION_DESIGN.md` (B1/B2 — the detector as a
service, wired into the ML/calibration loop). Seam C is the *product* bridge that
B1 explicitly deferred.

---

## 1. Goal

Let the YOLO zone detector (`baseline-v7`) **supply the structure of an untagged
PDF** so the existing remediation write-path can tag it — filling the exact gap
where **Adobe AutoTag is currently the only option**.

Concretely: `untagged.pdf → detect regions → order them → map to PDF tags →
build a /StructTreeRoot → hand the tagged buffer to the existing audit + remediation
+ re-audit plumbing`.

## 2. What we're actually bridging (grounded)

Two systems already exist; Seam C connects them. It is **not** greenfield.

- **The remediation write-path is issue-driven and mutates an *existing* tag tree.**
  Every `pdf-structure-writer` op starts with `getStructTreeRoot(doc)` and bails
  with *"No structure tree root found"* if absent
  (`pdf-structure-writer.service.ts:335-342`). The auto-remediation handler
  registry is metadata / flag / AI-value fixes only — **no structural tagging**
  (`pdf-auto-remediation.service.ts:82-108`). So today the pipeline *assumes tags
  already exist*.
- **Untagged PDFs get a tag tree from exactly one place: Adobe AutoTag**, in the
  worker (`accessibility.processor.ts:151-232`). It returns a fully tagged
  `taggedPdfBuffer` that then *replaces* the audit buffer. If Adobe is disabled or
  throws, the worker continues untagged and every downstream structure op no-ops.
  **There is no rule-based / pdfjs fallback that writes tags.**
- **The detector already emits into a structure-shaped model.** `Zone`
  (`schema.prisma:1957-2018`) already carries what a detector produces: `bounds`
  (bbox), `pageNumber`, `type`, `readingOrder` (an explicit slot),
  `parentZoneId`/`childZones`, `tableStructure`, `altText`, `source` (incl.
  `'yolo'`). The YOLO path already writes zones via `detectZones()`
  (`zone-extractor.service.ts`). So Seam C **reuses `Zone`** rather than inventing a
  model.

**The gap Seam C fills is precise:** produce a writable `/StructTreeRoot` from
detector regions, as an alternative to Adobe AutoTag.

## 3. The three hard cores (this is why Seam C is a project, not a wiring)

A layout detector gives **unordered, untagged rectangles**. A tag tree needs
**ordered, typed, content-bound structure elements.** Three things must be built:

### 3.1 Reading-order synthesis *(highest risk)*
The write-path *is* an ordered `/K` tree; order is implicit in the tree. The
detector supplies no sequence, and the YOLO→Zone path leaves `readingOrder` **null**
(`zone-extractor.service.ts:53-66`). Seam C must **synthesize** a column-aware
top-to-bottom order over `bounds` and populate `Zone.readingOrder` before it can
emit a tree. The audit side already has the geometry for this to reuse —
`analyzeReadingOrder` / `detectColumns` (`structure-analyzer.service.ts:840-900`).
*Wrong order = correct tags in the wrong sequence, which fails reading-order
validation **worse** than leaving the PDF untagged.*

### 3.2 Role → PDF tag mapping (+ heading levels)
There is **no central role→tag map today** — tags are written as literal strings
per call site. Seam C needs one for the 11 classes:
`paragraph→P`, `section-header→H1..H6`, `list-item→L`+`LI`/`LBody`, `figure→Figure`,
`caption→Caption`, `footnote→Note`, `table→Table`+`TR`/`TH`/`TD`,
`header/footer→Artifact` (pagination, *not* a StructElem), `toci→TOC`/`TOCI`,
`formula→Formula`. **Note the detector has a single `section-header` class** — it
does not tell you H1 vs H3. Heading *level* must be inferred (font size / ordering
heuristic), which `structure-analyzer` already does for the audit side.

### 3.3 MCID binding + coordinate reconciliation *(the technical core)*
The existing writer is deliberately **"MCID-safe" precisely because it never
creates MCID bindings — it only re-tags existing ones.** Building a tree from
geometry requires the opposite: associating each zone's bbox with the page's
marked-content sequences (BDC/MCID) so the tag actually points at the glyphs. No
current code does this. And the coordinate systems differ: detector output is
**PDF points, top-left origin**; pdf-lib / PDF content space is **bottom-left
origin**, with page `rotation`/`MediaBox` offsets to reconcile
(cf. `structure-analyzer.service.ts:801-807`). Get this wrong and figures/tables
bind to the wrong content.

## 4. Architecture

```
untagged.pdf
   │
   ▼  (YOLO service — already built, B2)
detect regions ──► Zone[] {page, bounds, type='yolo canonical', source:'yolo'}
   │
   ▼  NEW: order synthesis (column-aware)         → populates Zone.readingOrder
   ▼  NEW: heading-level inference                 → section-header → H1..H6
   ▼  NEW: hierarchy assembly (L>LI, Table>TR>TD)  → parentZoneId / tableStructure
   │
   ▼  NEW: buildStructTreeFromZones(doc, zones)    ← lives in pdf-structure-writer
   │        · role→tag map  · MCID binding  · coord reconciliation
   ▼
taggedPdfBuffer  ──►  [EXISTING] audit · pdf-structure-writer fixes · re-audit · ACR
```

Everything downstream of `taggedPdfBuffer` is **unchanged** — it's the same buffer
contract Adobe AutoTag already produces.

## 5. Insertion point

**The worker's untagged branch** (`accessibility.processor.ts:151-232`, the
`shouldAutoTag` block) — the single place an untagged PDF acquires a tag tree
today. A Seam-C producer slots in beside `adobeAutoTagService.tagPdf(...)`, emits a
`taggedPdfBuffer`, and hands it to the **same** `auditBuffer` / `saveRemediatedFile`
plumbing. Downstream audit, structure-writer, and re-audit need no changes.

The new tree-builder itself belongs in **`pdf-structure-writer.service.ts`** as a
`buildStructTreeFromZones(doc, zones[])` primitive — it already owns the MCID-safe
`createElement` / `reparentElement` / `appendToKids` context helpers.

## 6. Data-model work

`Zone` is schema-ready, but three things are missing to use it for remediation:
1. **Associate a zone set with a remediation `Job`** — today `Zone` is keyed on
   `fileId` / `bootstrapJobId` (ML side); there is no `Zone ↔ Job` relation.
2. **Populate `readingOrder`** (§3.1) — currently always null on yolo zones.
3. **A `Zone → /StructTreeRoot` serializer** — the inverse of the existing
   `struct-tree-serializer.ts` (which only reads a tree → JSON). Does not exist.

## 7. Relationship to Adobe AutoTag — phased

Adobe currently *replaces* the audit buffer, saves the remediated file, and feeds
`elementCounts` + `parsedFlags` into the AI-analysis flow and the
`autoTagStatus`/`postRemediationStatus` state machine
(`pdf-ai-analysis.controller.ts:487-559`). Two `/StructTreeRoot`s must never
coexist. So phase the relationship:

- **Phase 1 — fallback.** Run Seam C only when Adobe is disabled or fails (today
  that path just gives up). Pure upside, no regression risk.
- **Phase 2 — A/B.** Run both on the same doc, compare tagged output via the
  existing re-audit diff (`pdf-reaudit.service.ts:33`). Measures Seam C against
  Adobe objectively.
- **Phase 3 — default / cost lever.** Switch classes of documents to Seam C where
  it wins, reducing Adobe dependence.

## 8. Review / HITL

Reuse the existing AI-analysis apply surface (`pdf-ai-analysis.controller.ts`,
`Zone.aiConfidence` / `operatorVerified` / `decision`). Low-confidence detector
zones surface as suggestions (mirroring Adobe's `parsedFlags`) before the tree is
committed — the approve/apply/re-audit loop already exists.

## 9. Phasing (crawl → walk → run)

| Phase | Deliverable | Proves |
|---|---|---|
| **0 — Spike** | Run v7 on 5–10 real untagged PDFs; eyeball whether regions+classes are tag-quality and whether column ordering recovers sequence | **Go/no-go for the whole seam** |
| **1 — Order + map** | `readingOrder` synthesis + role→tag map + heading-level inference, unit-tested on Zone fixtures (no PDF writing yet) | The logic is correct in isolation |
| **2 — Tree builder** | `buildStructTreeFromZones` + MCID binding + coord reconciliation on simple single-column PDFs | The hard core works end-to-end |
| **3 — Worker seam (fallback)** | Wire into the untagged branch as Adobe fallback; re-audit shows improvement vs untagged | Real product value, zero regression |
| **4 — A/B vs Adobe** | Compare on a doc set | Objective quality bar |

## 10. Top risks

1. **Reading order** (§3.1) — the make-or-break; must beat "no tags" to be worth shipping.
2. **MCID binding + coordinates** (§3.3) — the technical core; nothing like it exists yet.
3. **Detector precision on target docs** — tagging *acts* on predictions; a wrong
   region becomes a wrong tag. v7 is strong in-distribution (0.75) but was measured
   on the annotation corpus, not on the untagged PDFs Seam C would target.
4. **Adobe state-machine overlap** (§7) — don't leave two `/StructTreeRoot`s or a
   half-updated `autoTagStatus`.

## 11. When to build — prerequisites & the gating test

**Not now.** Seam C is a multi-week project (three hard cores), and it *acts on the
detector's output*, so it must be built on a model proven good enough for the job.
Gate the build on all three:

1. **Detector live + validated (Seam A done).** Build on a trusted, monitored
   model. Nearly there — the service deploy is the last step of B2.
2. **The Phase-0 tag-quality spike passes** — the single most important test:
   run the detector on real *untagged target* PDFs and check by eye whether the
   boxes are tag-quality (right regions, right classes) **and** whether a
   column-aware ordering recovers reading order. This is cheap and de-risks the
   entire investment. If the boxes aren't tag-quality, invest in detector accuracy
   (more data, Seam A) *before* Seam C.
3. **A concrete product driver** — Adobe AutoTag cost, a class of PDFs Adobe tags
   poorly, or a strategic need to reduce third-party dependence. Absent a driver,
   improving/measuring the detector (Seam A) is the better use of the same effort.

**Recommended sequence:** finish Seam A (deploy + validate) → run the Phase-0 spike
→ if it passes **and** there's a driver, schedule Seam C as its own project starting
at Phase 1. This design doc is the prep so the team can scope it; the build waits
for the gate.

---

*Grounding: exploration of `src/services/pdf/*` remediation write-path,
`accessibility.processor.ts`, `adobe-autotag.service.ts`,
`pdf-structure-writer.service.ts`, `structure-analyzer.service.ts`, the `Zone`
model, and `zone-extractor/*`.*
