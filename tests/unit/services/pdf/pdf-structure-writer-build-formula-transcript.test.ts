/**
 * Regression coverage for buildFormulaTranscript: a coarse, position-
 * annotated text transcript of a Figure's own marked-content span, for
 * the real multi-fragment inline math expressions extractSingleGlyphAltText
 * doesn't cover (see that method's own doc comment for the single-glyph
 * shape this one is the complement of). Confirmed real and live on
 * Math_Weir_PDF.pdf: 217/217 (100%) of the remaining struct-tree-only
 * missing-alt Figures build a non-null transcript.
 */
import { describe, it, expect } from 'vitest';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

describe('buildFormulaTranscript', () => {
  it('tags a fragment as "raised" when its Td y-offset (since the enclosing Tm) exceeds the threshold', () => {
    // Matches the real "P^{XL,i}"-shape samples: one Tm establishes the
    // main-line position, a small positive Td walk lands the next
    // fragment above it.
    const content = `/Figure <</MCID 0 >>BDC
BT
11 0 0 11 283.84 686.71 Tm
(P)Tj
2.406 2.023 Td
(XL)Tj
ET
EMC
`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);

    expect(transcript).toContain('[main] "P"');
    expect(transcript).toContain('[raised] "XL"');
  });

  it('tags a fragment as "lowered" when its Td y-offset is meaningfully negative', () => {
    const content = `/Figure <</MCID 1 >>BDC
BT
11 0 0 11 100 200 Tm
(p)Tj
0 -1.5 Td
(p)Tj
ET
EMC
`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 1);

    expect(transcript).toContain('[main] "p"');
    expect(transcript).toContain('[lowered] "p"');
  });

  it('tags a fragment as "smaller-script" when its own Tm uses a meaningfully smaller font scale than the span\'s first Tm, even at roughly the same Y', () => {
    // Matches the real "X_i,n"-shape samples: each sub-part gets its OWN
    // fresh, absolutely-positioned Tm (not a Td walk) with a shrunken
    // scale (7 vs the main line's 11).
    const content = `/Figure <</MCID 0 >>BDC
BT
/T1_5 1 Tf
11 0 0 11 329.87 610.91 Tm
(X)Tj
ET
q
312 603.91 36 21 re
W n
BT
/T1_5 1 Tf
7 0 0 7 338.4 607.72 Tm
(i)Tj
ET
Q
EMC
`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);

    expect(transcript).toContain('[main] "X"');
    expect(transcript).toContain('[smaller-script] "i"');
  });

  it('represents a hex-only (composite-font) fragment as "[symbol]" rather than dropping or guessing at it', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n<0037>Tj\n(X)Tj\nET\nEMC\n`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);

    expect(transcript).toContain('[main] [symbol]');
    expect(transcript).toContain('[main] "X"');
  });

  it('preserves BOTH the readable text and a [symbol] marker, in source order, when a single TJ array mixes literal and hex operands (CodeRabbit finding: the hex operand used to silently vanish whenever any readable text shared its array)', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n[(V) <0037> (X)]TJ\nET\nEMC\n`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);

    expect(transcript).toContain('[main] "V" [symbol] "X"');
  });

  it('notes a drawn line/curve in the header when the span contains a fill operator, without claiming to know what it is', () => {
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
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);

    expect(transcript).toContain('also contains a drawn line or curve');
  });

  it('refuses a Figure sharing its span with a real embedded image (Do), same safety gate as extractSingleGlyphAltText', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(slug line text)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`;
    expect(pdfStructureWriterService.buildFormulaTranscript(content, 0)).toBeNull();
  });

  it('returns null when the MCID cannot be found on this page', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(X)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.buildFormulaTranscript(content, 999)).toBeNull();
  });

  it('returns null for a Figure with no text-showing operator at all', () => {
    const content = `/Figure <</MCID 0 >>BDC\nq\n0 0 10 10 re\nW n\nQ\nEMC\n`;
    expect(pdfStructureWriterService.buildFormulaTranscript(content, 0)).toBeNull();
  });

  it('produces a multi-line transcript preserving each fragment in document order for a real multi-part shape', () => {
    const content = `/Figure <</MCID 0 >>BDC
BT
11 0 0 11 233.66 595.59 Tm
(negative likelihood ration)Tj
12.949 2.006 Td
(C)Tj
ET
EMC
`;
    const transcript = pdfStructureWriterService.buildFormulaTranscript(content, 0);
    expect(transcript).not.toBeNull();

    const lines = transcript!.split('\n').slice(1); // drop the header line
    expect(lines[0]).toBe('[main] "negative likelihood ration"');
    expect(lines[1]).toBe('[raised] "C"');
  });
});
