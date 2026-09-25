export const pdfConfig = {
  // Real incident (2026-09-25): a genuine production comparison-study PDF
  // (BMW_188935_BMW E36.pdf, ~1.43GB) was rejected by the old 500MB default.
  // Raised to 2GB per explicit decision to support real large-document
  // uploads. This meaningfully raises OOM risk for the ECS task -- pdf-lib
  // and pdfjs each hold their own full in-memory parse of the file
  // (see loadWithPdfLib/loadWithPdfjs in pdf-parser.service.ts) -- consistent
  // with this codebase's own prior finding that a much smaller 377-page
  // document already OOM-killed an 8GB task during a different per-page
  // operation (see maxContrastPages below). If a 1-2GB PDF OOM-kills the
  // task, the ECS task definition's memory (not stored in this repo --
  // fetched live from AWS) is the next thing to check/raise, same as that
  // precedent.
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
  timeout: 120000,
  chunkSize: 10,
};
