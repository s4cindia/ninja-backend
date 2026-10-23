export const pdfConfig = {
  // Real incident (2026-09-25): a genuine production comparison-study PDF
  // (BMW_188935_BMW E36.pdf, ~1.43GB) was rejected by the old 500MB default.
  // Raised to 2GB per explicit decision to support real large-document
  // uploads. This meaningfully raises OOM risk for the ECS task -- pdf-lib
  // and pdfjs each hold their own full in-memory parse of the file
  // (see loadWithPdfLib/loadWithPdfjs in pdf-parser.service.ts) -- consistent
  // with this codebase's own prior finding that a much smaller 377-page
  // document already OOM-killed a 4GB task during a different per-page
  // operation, fixed by raising that task to 8GB (see maxContrastPages
  // below). If a 1-2GB PDF OOM-kills the task, the ECS task definition's
  // memory (not stored in this repo -- fetched live from AWS) is the next
  // thing to check/raise, same as that precedent.
  maxFileSizeMB: parseInt(process.env.MAX_PDF_FILE_SIZE_MB || '2000', 10),
  // Hard upload limit — rejects PDFs with more pages than this before any processing.
  // Set MAX_PDF_PAGES in .env to override (0 = no limit). Defaults to 5000.
  // MAX_AUDIT_PAGES is the effective processing cap and is usually much lower.
  maxPages: parseInt(process.env.MAX_PDF_PAGES || '5000', 10),
  // Defaults to uncapped (0) — a silent default cap here previously truncated
  // every audit of a >50-page document to its first 50 pages with no signal
  // to whoever was running it (found via a live Comparison Study trial: a
  // 414-page book was silently audited as if it were 50 pages, and every
  // downstream metric — pageCount, table/alt-text/contrast/heading
  // validation, score, Matterhorn compliance — was computed against that
  // truncated view). Set MAX_AUDIT_PAGES to a positive number in .env for
  // faster local-dev iteration on large PDFs; never rely on an implicit
  // default to do this in a shared/staging/production environment.
  maxAuditPages: parseInt(process.env.MAX_AUDIT_PAGES || '0', 10),
  // Same "silent truncation" issue as maxAuditPages above, found independently
  // in PdfContrastValidator: its own MAX_PAGES_CONTRAST=50 constant capped
  // contrast checking regardless of maxAuditPages, so an 805-page document
  // (maxAuditPages now uncapped) still only ever had its first 50 pages
  // checked for color contrast. Defaults to 0 (uncapped) for the same reason;
  // set MAX_CONTRAST_PAGES to a positive number in .env for faster local-dev
  // iteration on large PDFs -- contrast checking renders each page to canvas
  // via pdfjs + @napi-rs/canvas, real per-page cost unlike most other
  // validators, so this is the one cap worth having an explicit opt-in for
  // even in a shared environment if audit latency on very long documents
  // becomes a problem in practice.
  //
  // Confirmed live: a 377-page document (Math_Weir_PDF.pdf) OOM-killed the
  // ECS task (exit 137, "OutOfMemoryError: container killed due to memory
  // usage") during this exact per-page render loop, on a 4GB task -- fixed
  // primarily by bumping the task to 8GB and adding pdfjsPage.cleanup() per
  // page in pdf-contrast.validator.ts (releases pdfjs-dist's own internal
  // per-page render caches instead of leaving that to GC timing). This cap
  // is a further opt-in mitigation for anyone hitting the same wall on an
  // even larger document or a smaller task size -- not changed to a default
  // cap here, for the same reason maxAuditPages above isn't: a silent
  // default cap is a worse failure mode than the one it prevents.
  maxContrastPages: parseInt(process.env.MAX_CONTRAST_PAGES || '0', 10),
  supportedVersions: ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0'],
  workerSrc: 'pdfjs-dist/build/pdf.worker.mjs',
  // Real incident (2026-10-15): a real document (Math_Olszewski_PDF.pdf, a
  // PDF batch item) hung inside PdfComprehensiveParser.parse -- no further
  // log output, ever -- and sat there for ~24h with nothing to catch it,
  // permanently wedging a worker's concurrency slot (and, for a batch item,
  // a tenant's weighted budget unit, since the lease heartbeat keeps
  // renewing independently of whether real progress is happening). There
  // was previously no timeout anywhere in runAuditFromBuffer at all -- the
  // old `timeout: 120000` field here was dead code, never actually wired
  // up to anything. 15 minutes is deliberately generous: comfortably above
  // any legitimately slow real audit seen in this codebase's history (even
  // 2GB/multi-hundred-page documents), so this should only ever fire on a
  // genuine hang, not a slow-but-working comprehensive scan.
  auditTimeoutMs: parseInt(process.env.PDF_AUDIT_TIMEOUT_MS || String(15 * 60 * 1000), 10),
  // Real incident (2026-10-17): PdfAltTextValidator processed every image
  // strictly sequentially (one Gemini vision call awaited at a time before
  // starting the next), which looked identical to a hang in the logs --
  // total silence between "Found N images" and the final auditTimeoutMs
  // timeout above, since there's no per-image logging and no error to
  // retry/catch on the happy path. For an image-heavy document (506 images
  // on Math_Olszewski_PDF.pdf, 5934 on FMHE_PDF.pdf), real per-image Gemini
  // latency alone adds up past the 15-minute budget with nothing actually
  // broken. 8 is a conservative starting point -- high enough to cut
  // wall-clock time meaningfully, low enough to stay well under Gemini's
  // own rate limits (geminiRateLimiter's own limit is 60/min and advisory
  // only, so the real ceiling is Gemini's API, which retryWithBackoff
  // already handles via 429 backoff).
  altTextConcurrency: parseInt(process.env.PDF_ALT_TEXT_CONCURRENCY || '8', 10),
  // Same worker-pool pattern as altTextConcurrency above, applied to
  // PdfContrastValidator's per-page canvas rendering (Stage A of its
  // render/score split -- see that validator's own header comment) rather
  // than its per-item scoring, which stays sequential because it reads and
  // writes a genuinely cross-page, order-dependent accumulator
  // (backgroundSignatureCounts). Defaults far lower than altTextConcurrency:
  // contrast pages are full-resolution live canvas rasters held in memory
  // simultaneously by this many workers, not alt-text's pre-extracted,
  // size-capped (1024px) image buffers -- the same per-page render loop
  // this concurrency now parallelizes already OOM-killed a 4GB ECS task on
  // a 377-page document at concurrency 1 (see maxContrastPages' doc comment
  // above), so raise this only after load-testing at the real task memory
  // limit against that document and the 2040-page FMHE_PDF.pdf case.
  contrastRenderConcurrency: parseInt(process.env.PDF_CONTRAST_RENDER_CONCURRENCY || '2', 10),
  // AiAnalysisService.applyApprovedSuggestions' page-grouped concurrency
  // for color-contrast-fix application (Phase 2 of the apply-loop
  // parallelism work) -- the one suggestion type there that's genuinely
  // page-local-safe, now that pdf-contrast-writer.service.ts's own
  // verification step serializes just the target page instead of the
  // whole document (extractSinglePageBuffer) rather than doc.save()-ing
  // the whole shared document per fix attempt. A page's own suggestions
  // still run sequentially within its own closure; only DIFFERENT pages'
  // closures run concurrently with each other. 4 is a moderate starting
  // point, not yet load-tested against a large real document -- raise
  // only after measuring wall-clock and memory on one.
  applyPageConcurrency: parseInt(process.env.PDF_APPLY_PAGE_CONCURRENCY || '4', 10),
  chunkSize: 10,
};
