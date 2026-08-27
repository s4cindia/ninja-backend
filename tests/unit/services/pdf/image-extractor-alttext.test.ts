import { describe, it, expect } from 'vitest';
import { PDFContext, PDFDict, PDFName, PDFString } from 'pdf-lib';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

// extractFigureInfo is private; exercise via cast with real pdf-lib primitives
// (no full PDFDocument needed — extractFigureInfo only reads dict entries).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = imageExtractorService as any;

function figureDict(entries: Record<string, PDFString>): PDFDict {
  const context = PDFContext.create();
  const dict = PDFDict.withContext(context);
  for (const [key, value] of Object.entries(entries)) {
    dict.set(PDFName.of(key), value);
  }
  return dict;
}

describe('extractFigureInfo — Alt vs ActualText precedence', () => {
  it('preserves an explicit empty /Alt even when /ActualText is non-empty (regression)', () => {
    // A Figure with both an empty /Alt (the decorative marker) and a stale/redundant
    // non-empty /ActualText must keep altText === '', not have it overwritten by
    // ActualText — otherwise the decorative marker silently disappears on re-extraction.
    const node = figureDict({
      Alt: PDFString.of(''),
      ActualText: PDFString.of('A red apple'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('');
  });

  it('falls back to /ActualText when /Alt is absent entirely', () => {
    const node = figureDict({
      ActualText: PDFString.of('A red apple'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('A red apple');
  });

  it('uses /Alt as-is when both are present and non-empty', () => {
    const node = figureDict({
      Alt: PDFString.of('Alt text wins'),
      ActualText: PDFString.of('Actual text loses'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('Alt text wins');
  });
});
