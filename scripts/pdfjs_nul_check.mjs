import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

const PATH = process.env.PDF_PATH || 'C:/Users/avrve/Downloads/25thMay2026/Math_Nikitopoulos_PDF.pdf';
const NUL = String.fromCharCode(0);

const data = new Uint8Array(fs.readFileSync(PATH));
const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

let nulItems = 0;
const nulPages = new Set();
const sample = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent({ includeMarkedContent: true });
  for (const it of tc.items) {
    if (typeof it.str === 'string' && it.str.indexOf(NUL) !== -1) {
      nulItems++;
      nulPages.add(p);
      if (sample.length < 6) {
        sample.push({
          page: p,
          codes: [...it.str].slice(0, 14).map((c) => c.charCodeAt(0)),
        });
      }
    }
  }
}
console.log('pdfjs text items containing U+0000 (NUL):', nulItems);
console.log('pages affected:', nulPages.size, [...nulPages].slice(0, 25));
console.log('samples (char codes):', JSON.stringify(sample));
