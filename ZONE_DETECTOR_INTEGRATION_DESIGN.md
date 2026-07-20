# Zone Detector Integration — Design (B1)

**Status:** Approved — §7 decisions settled 2026-07-20; ready for B2
**Date:** 2026-07-19
**Author:** Venkat (with Claude Code)
**Scope:** B1 — decide the *write-path deployment shape* for graduating the trained
YOLOv8 page-layout detector (`baseline-v7`) from the calibration pipeline into a
runnable service. B2 (build) follows once this is agreed.

---

## 1. Goal

`baseline-v7` is a YOLOv8 detector that, per PDF page, emits bounding boxes each
labelled with one of **11 classes**: `paragraph, section-header, table, figure,
caption, footnote, header, footer, list-item, toci, formula`. It scores TEST
mAP50-95 **0.753** (formula **0.737**) on the pinned page-split baseline.

This design decides **how the model is served** and **where its output enters the
existing system**, grounded in the current codebase rather than in the abstract.

---

## 2. Current state (grounded)

### 2.1 Two separate worlds

- **Product PDF audit** (`src/services/pdf/*`) works off the PDF's **tag tree +
  pdfjs elements** — `pdf-audit.service.ts` orchestrates validators that each
  `validate(parsed: PdfParseResult)`. It **never reads layout regions or the
  `Zone` table** (grep: zero references from `services/pdf/*` to
  `prisma.zone`/`calibrationRun`).
- **Zone/ML pipeline** (`src/services/zone-extractor/*`, `src/services/calibration/*`)
  produces layout boxes from **external detectors** (docling, pdfxt) and the
  tagged-PDF structure walk, persisting them to `Zone.bounds`. This is the
  annotation/calibration/training stack the model was trained on.

The `Zone` / `CalibrationRun` data is **strictly** behind the
`admin/corpus`, `calibration`, `zone-*`, `training`, `ml-metrics` routes. There is
**no product consumer** of detected boxes today.

### 2.2 The half-built handoff already in place

On model promotion, `evaluation.service.ts:122` writes the winning weights path to
SSM `/ninja/zone-extractor/model-weights-path` (and reverts on rollback) — **but no
service reads it yet**. This is the intended plug for a detector; the inference
server is greenfield.

### 2.3 Serving patterns already in the repo (to mirror, not invent)

| Pattern | Example | Shape |
|---|---|---|
| **Async HTTP job (submit + poll)** | `zone-extractor/docling-client.ts` | `POST {DOCLING_SERVICE_URL}/detect-async` → poll `/jobs/{id}`; handles container-restart re-submit; up to 2.5h |
| Sync HTTP request | `pdfxt/pdfxt-client.ts` | `POST {PDFXT_SERVICE_URL}/detect`, 90s timeout, Bearer key, 3× retry |
| ECS RunTask (batch) | `services/training/training.service.ts` | `RunTaskCommand` on `ninja-training-service`, params via SSM, completion via webhook |

- The docling GPU service is **ECS/EC2 (g4dn/T4), scale-to-zero**, discovered via
  **AWS Cloud Map DNS** in `DOCLING_SERVICE_URL`
  (`infrastructure/gpu/setup-gpu-infrastructure.sh:195`). Endpoint convention is
  one `*_SERVICE_URL` env var per service (`.env.example:58-63`).
- Detection contract (already defined): `DetectedZone { pageNumber, bbox,
  zoneType, confidence, source }`, `BBox { x, y, w, h }` (`zone-extractor/types.ts`).

---

## 3. Recommended deployment shape

**A persistent GPU inference sidecar, `ninja-zone-detector`, mirroring the docling
service.**

- ECS/EC2 on the **existing GPU capacity** (`ninja-docling-gpu-asg` g4dn/T4),
  scale-to-zero, Cloud Map DNS → new env `YOLO_SERVICE_URL`.
- Exposes **async** `/detect-async` + `/jobs/{id}` (and a sync `/detect` for small
  jobs), returning the **existing** contract `{ zones: [{ page, bbox, label,
  confidence }] }`.
- **Rasterizes pages internally** (as docling and `training-export-service/export.py`
  already do — pdf2image @150 DPI, letterbox to 1280px), so the Node backend never
  renders pages for detection.
- Loads weights from SSM `/ninja/zone-extractor/model-weights-path`.

### Why this shape (and not the others)

| Option | Verdict |
|---|---|
| **GPU inference sidecar (async HTTP)** ✅ | Proven (docling clone), warm for on-demand, reuses SSM + Cloud Map + `*_SERVICE_URL` conventions, runs on existing GPU capacity. **Recommended.** |
| ECS RunTask per PDF | Good for batch, but ~minutes cold-start per request — wrong for interactive audit. |
| Hosted endpoint (SageMaker) | New infra + cost; no such pattern in the repo; self-hosted GPU is cheaper and already operated. |
| Sync HTTP (pdfxt-style) | A multi-page PDF on GPU can exceed a 90s sync budget; async is safer. |

---

## 4. Recommended first consumer

**Seam A — add the detector as a third `source: 'yolo'` in the zone-extractor /
calibration flow** (alongside docling + pdfxt), landing in `Zone` for
reconciliation, the operator annotation UI, and live mAP.

- Lowest-risk, immediately useful (auto-annotation + measuring the live model
  against the pinned baseline), and it is exactly the pipeline the model was
  trained for.
- Node changes reduce to a `yolo-client.ts` (mirror `docling-client.ts`) + a
  `source` branch in `runCalibration` / `detectZones`.

**Seam C — feeding boxes into the product audit path** (so detections drive
reading-order / table / caption / alt-text remediation) is a **separate, larger
effort**: `pdf-audit.service.ts` consumes tags/pdfjs only and never reads `Zone`,
so this needs a genuinely new bridge (`Zone` or the detector response →
`PdfParseResult`/validators). Out of scope for the first landing.

---

## 5. Blockers to resolve in B1 → B2 (not optional)

1. **Class taxonomy: 11 vs 8.** Backend `CanonicalZoneType` (`zone-extractor/types.ts`)
   is 8 classes; `mapDoclingLabel` (`zone-type-mapper.ts:13-16`) collapses
   `list_item`/`formula` → `paragraph`; `evaluation.service.ts` `CLASS_NAMES` is 8.
   → The detector's best new classes (**list-item, toci, formula**) would be
   silently dropped. **Widening the canonical union + mappers + evaluation list to
   11 is a prerequisite** (this is task **F1**). `Zone.type/operatorLabel/aiLabel`
   are free strings and already hold these values, so the DB is fine.
2. **Coordinate inversion.** YOLO emits normalized center boxes `(cx,cy,w,h)∈[0,1]`
   in 150-DPI letterboxed image space; the backend expects absolute PDF points,
   **top-left origin, corner `{x,y,w,h}`**. The inference service must invert
   `export.py:bbox_to_yolo` (denormalize by page point dims, center→corner, undo the
   letterbox scale) before returning — else every downstream box is wrong.
3. **Weights format gap.** Training produces `best.pt` (v7 is a `.pt` in S3), but the
   SSM contract expects an **ONNX** path. **Decision (§7.2): load `.pt` directly
   in-service** via Ultralytics — the sidecar is Python/Ultralytics anyway, so `.pt`
   is native and needs no export step. Promotion (`evaluation.service.ts`) is
   updated to write the `.pt` S3 path (or a format-agnostic weights path) to SSM.
   ONNX is deferred as a later inference-speed optimization, not a launch blocker.

---

## 6. Proposed work breakdown

- **B1 (this doc):** deployment shape = GPU sidecar; first consumer = calibration
  (Seam A); three blockers scoped.
- **B2 (build):**
  1. **F1** — widen taxonomy to 11 (canonical union, docling/pdfxt mappers,
     `evaluation.service` `CLASS_NAMES`). *Unblocks everything; do first.*
  2. `ninja-zone-detector` service — Python/Ultralytics, mirror
     `docling-service/main.py` + `infrastructure/gpu/`; loads `.pt` from SSM weights
     path; internal rasterization; coordinate inversion; `/detect-async` +
     `/detect`. Deployed on the **shared docling GPU ASG** (§7.3).
  3. `yolo-client.ts` — mirror `docling-client.ts`; `YOLO_SERVICE_URL`.
  4. Wire `source: 'yolo'` into `runCalibration` / `detectZones`.
  5. Register v7 `best.pt` S3 path to SSM `/ninja/zone-extractor/model-weights-path`
     and update `evaluation.service.ts` promotion to write the `.pt` path.

---

## 7. Decisions (settled 2026-07-20)

1. **Graduation scope → (i) ML-loop only.** Serve the detector + Seam A
   (auto-annotation / live mAP). Lands the model as a third annotation source and
   proves it in production without the larger product-audit bridge. Seam C
   (detections driving real remediation) is explicitly deferred to a follow-up,
   pending a product-side call on which validators consume boxes.
2. **Weights format → load `.pt` in-service.** The sidecar is Python/Ultralytics,
   so `.pt` is native and needs no conversion; promotion writes the `.pt` S3 path to
   SSM. ONNX export is deferred as a later inference-speed optimization, not a
   launch blocker. *(See §5.3.)*
3. **GPU → reuse the existing docling GPU ASG** (`ninja-docling-gpu-asg`). Cheaper
   and already operated; the detector is intermittent/on-demand like docling, and
   the ASG already scales 0→2. Contention risk (docling + detector both wanting a
   GPU) is accepted for now and mitigated by the existing scale-up pattern; split to
   a dedicated ASG only if contention is observed in practice.

---

*Grounding: exploration of `src/services/pdf`, `src/services/zone-extractor`,
`src/services/calibration`, `src/services/training`, `docling-service`,
`infrastructure/gpu`. Pinned-split baseline + v7 results in
`memory/project_phase2_readiness.md` and PR #423.*
