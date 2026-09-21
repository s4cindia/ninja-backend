/**
 * Regression coverage for extractSingleGlyphAltText: deterministically
 * reads alt text for a Figure whose entire content is a single, self-
 * contained inline math glyph (e.g. "V", "X") rather than a real photo or
 * diagram -- an InDesign "PlacedGraphic" convention for embedded math
 * notation. Confirmed real and live on Math_Weir_PDF.pdf: 219 of 437
 * struct-tree-only missing-alt Figures (50.1%) are exactly this shape.
 */
import { describe, it, expect } from 'vitest';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

describe('extractSingleGlyphAltText', () => {
  it('extracts the single readable character from a Figure with one hex prefix glyph + one readable Tj (the confirmed real "V" shape)', () => {
    const content = `/Figure <</MCID 0 >>BDC
/PlacedGraphic /MC3 BDC
q
342.724 241.915 8.107 10.904 re
W n
BT
0 g
/GS1 gs
/C2_0 1 Tf
0 Tw 11 0 0 11 345.0917 245.7062 Tm
<0005>Tj
/T1_6 1 Tf
-0.219 -0.307 Td
(V)Tj
ET
EMC
EMC
`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 0)).toBe('V');
  });

  it('extracts a glyph that also has a small decorative stroke in the same span (the confirmed real "X-bar" overline shape)', () => {
    const content = `/Figure <</MCID 5 >>BDC
/PlacedGraphic /MC6 BDC
/GS0 gs
q 1 0 0 1 448.9354 312.3628 cm
0 0 m
5.5 0 l
S
Q
q
446.136 303 9.841 10.495 re
W n
BT
0 g
/T1_7 1 Tf
0 Tw 11 0 0 11 446.5604 303.1753 Tm
(X)Tj
ET
EMC
EMC
`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 5)).toBe('X');
  });

  it('refuses a Figure that also contains a real embedded image sharing the same span (the confirmed real cover-page slug-line shape)', () => {
    const content = `/Figure <</MCID 0 >>BDC
/PlacedPDF /MC0 BDC
q
27.04 357.2 608.961 381.6 re
W n
BT
0 0 0 1 k
/T1_0 1 Tf
8 0 0 8 250.3725 347.1338 Tm
[(E9472/W)30.1 (eir/F)45 (r)20.1 (ont_co)15 (v)25 (er_inside/7)95 (46841/mh-R1)]TJ
ET
Q
q
540.4799922 0 0 328.560041 59.5993881 373.7991509 cm
/Im0 Do
Q
EMC
EMC
`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 0)).toBeNull();
  });

  it('refuses a single text-show fragment that decodes to more than one character (CodeRabbit finding: the method promises a single GLYPH, not just a non-empty fragment)', () => {
    const content = `/Figure <</MCID 6 >>BDC\nBT\n(V2)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 6)).toBeNull();
  });

  it('refuses a Figure with multiple readable text-show fragments (the confirmed real multi-part-formula shape)', () => {
    const content = `/Figure <</MCID 1 >>BDC
/PlacedGraphic /MC0 BDC
EMC
0.5 w
q 1 0 0 1 356.6875 598.3441 cm
0 0 m
47.219 0 l
S
Q
BT
0 g
/T1_5 1 Tf
-0.003 Tc 11 0 0 11 233.6562 595.5941 Tm
(negative likelihood ration)Tj
0 Tc 12.949 2.006 Td
(C)Tj
ET
EMC
`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 1)).toBeNull();
  });

  it('returns null when the MCID cannot be found on this page', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(V)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 999)).toBeNull();
  });

  it('drops octal-escaped control-range bytes rather than leaking them as digit characters', () => {
    // \037 must decode to byte 0x1F (dropped, non-printable), NOT the
    // literal digit characters "0", "3", "7" -- a real bug caught live
    // while building this method's own validation diagnostic.
    const content = `/Figure <</MCID 2 >>BDC\nBT\n(V\\037)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 2)).toBe('V');
  });

  it('returns null when the sole readable fragment is empty after dropping non-printable bytes', () => {
    const content = `/Figure <</MCID 3 >>BDC\nBT\n(\\037\\036\\035)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 3)).toBeNull();
  });

  it('returns null for a Figure with no text-showing operator at all', () => {
    const content = `/Figure <</MCID 4 >>BDC\nq\n0 0 10 10 re\nW n\nQ\nEMC\n`;
    expect(pdfStructureWriterService.extractSingleGlyphAltText(content, 4)).toBeNull();
  });
});
