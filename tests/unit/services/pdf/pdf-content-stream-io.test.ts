import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

// Regression coverage for the exact decode/write logic previously inlined in
// pdf-modifier.service.ts's private decodePageContent — that method now
// delegates here, so this test locks the behavior both share.

async function realPdf(): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText('Hello world', { x: 50, y: 500, size: 14, font });
  // save + reload so the text draw is flushed into a real, loadable content stream
  return PDFDocument.load(await src.save());
}

describe('decodePageContent', () => {
  it('decodes a real content stream to a latin1 string containing the page operators', async () => {
    const doc = await realPdf();
    const content = decodePageContent(doc, 1);
    expect(content).toBeTruthy();
    expect(content).toContain('Tj'); // text-show operator from drawText
    expect(content).toContain('BT');
    expect(content).toContain('ET');
  });

  it('returns null for an out-of-range page rather than throwing', async () => {
    const doc = await realPdf();
    expect(decodePageContent(doc, 99)).toBeNull();
  });
});

describe('writePageContent', () => {
  it('round-trips: content written back is what gets decoded next', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    const modified = original + '\n% a harmless comment appended for this test\n';

    writePageContent(doc, 1, modified);

    const reDecoded = decodePageContent(doc, 1);
    expect(reDecoded).toBe(modified);
  });

  it('survives a save/reload cycle (the new stream is really persisted, not just in-memory)', async () => {
    const doc = await realPdf();
    const original = decodePageContent(doc, 1)!;
    const appended = original + '\nq 1 0 0 RG 0 0 10 10 re S Q\n';

    writePageContent(doc, 1, appended);
    const reloaded = await PDFDocument.load(await doc.save());

    const finalContent = decodePageContent(reloaded, 1);
    expect(finalContent).toContain('1 0 0 RG');
    expect(finalContent).toContain('Tj'); // original text-show operator preserved
  });
});
