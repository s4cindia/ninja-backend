/**
 * QC brief Theme B2 (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * getFormulaTranscriptShapeSignals -- shares buildFormulaTranscript's own
 * content-stream walk (computeFormulaTranscriptData) so the shape signals
 * used by ai-analysis.service.ts's gate can never drift from what
 * buildFormulaTranscript itself actually walked.
 */
import { describe, it, expect } from 'vitest';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

describe('getFormulaTranscriptShapeSignals', () => {
  it('reports a small yRange for one inline expression with a small sub/superscript offset', () => {
    const content = `/Figure <</MCID 0 >>BDC
BT
11 0 0 11 283.84 686.71 Tm
(P)Tj
2.406 2.023 Td
(XL)Tj
ET
EMC
`;
    const signals = pdfStructureWriterService.getFormulaTranscriptShapeSignals(content, 0);

    expect(signals).not.toBeNull();
    expect(signals!.hasDrawnPath).toBe(false);
    expect(signals!.yRange).toBeCloseTo(2.023, 3);
  });

  it('reports a large yRange for widely-spaced text runs (a diagram\'s axis/quadrant labels, not one inline expression)', () => {
    const content = `/Figure <</MCID 0 >>BDC
BT
11 0 0 11 100 700 Tm
(Have to 10)Tj
0 -40 Td
(Able to 5)Tj
0 -40 Td
(Want to 10)Tj
ET
EMC
`;
    const signals = pdfStructureWriterService.getFormulaTranscriptShapeSignals(content, 0);

    expect(signals).not.toBeNull();
    expect(signals!.yRange).toBeGreaterThan(50);
  });

  it('reports hasDrawnPath true when the span contains a fill operator', () => {
    const content = `/Figure <</MCID 0 >>BDC
q
0 0 m
1.487 1.092 l
3.907 -3.693 l
f
Q
BT
(X)Tj
ET
EMC
`;
    const signals = pdfStructureWriterService.getFormulaTranscriptShapeSignals(content, 0);

    expect(signals).not.toBeNull();
    expect(signals!.hasDrawnPath).toBe(true);
  });

  it('returns null when buildFormulaTranscript itself would (shares the same refusal/not-found conditions)', () => {
    const noText = `/Figure <</MCID 0 >>BDC\nq\n0 0 10 10 re\nW n\nQ\nEMC\n`;
    expect(pdfStructureWriterService.getFormulaTranscriptShapeSignals(noText, 0)).toBeNull();

    const sharesImage = `/Figure <</MCID 0 >>BDC\nBT\n(slug line text)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`;
    expect(pdfStructureWriterService.getFormulaTranscriptShapeSignals(sharesImage, 0)).toBeNull();

    const notFound = `/Figure <</MCID 0 >>BDC\nBT\n(X)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.getFormulaTranscriptShapeSignals(notFound, 999)).toBeNull();
  });
});
