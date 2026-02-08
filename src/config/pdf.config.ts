export const pdfConfig = {
  maxFileSizeMB: 100,
  maxPages: 1000,
  supportedVersions: ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0'],
  workerSrc: 'pdfjs-dist/build/pdf.worker.mjs',
  timeout: 120000,
  chunkSize: 10,
};
