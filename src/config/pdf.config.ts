export const pdfConfig = {
  maxFileSizeMB: parseInt(process.env.MAX_PDF_FILE_SIZE_MB || '500', 10),
  // Hard upload limit — rejects PDFs with more pages than this before any processing.
  // Set MAX_PDF_PAGES in .env to override (0 = no limit). Defaults to 5000.
  // MAX_AUDIT_PAGES is the effective processing cap and is usually much lower.
  maxPages: parseInt(process.env.MAX_PDF_PAGES || '5000', 10),
  // Set MAX_AUDIT_PAGES=50 in .env for fast local testing of large PDFs (0 = no limit)
  maxAuditPages: parseInt(process.env.MAX_AUDIT_PAGES || '0', 10),
  supportedVersions: ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0'],
  workerSrc: 'pdfjs-dist/build/pdf.worker.mjs',
  timeout: 120000,
  chunkSize: 10,
};
