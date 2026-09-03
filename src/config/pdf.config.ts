export const pdfConfig = {
  maxFileSizeMB: parseInt(process.env.MAX_PDF_FILE_SIZE_MB || '500', 10),
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
  maxContrastPages: parseInt(process.env.MAX_CONTRAST_PAGES || '0', 10),
  supportedVersions: ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0'],
  workerSrc: 'pdfjs-dist/build/pdf.worker.mjs',
  timeout: 120000,
  chunkSize: 10,
};
