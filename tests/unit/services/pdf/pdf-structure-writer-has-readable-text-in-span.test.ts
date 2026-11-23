/**
 * QC brief Theme B1a (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * hasReadableTextInSpan -- a plain presence check used to detect a Figure
 * whose own span wraps both an embedded raster (Do) and literal text drawn
 * directly over it (the BATNA-box shape, F-09).
 */
import { describe, it, expect } from 'vitest';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';

describe('hasReadableTextInSpan', () => {
  it('returns true for a span with a real readable Tj run, even alongside a Do (embedded image)', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(cost efficient)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`;
    expect(pdfStructureWriterService.hasReadableTextInSpan(content, 0)).toBe(true);
  });

  it('returns false for a span with only a Do and no text-show op', () => {
    const content = `/Figure <</MCID 0 >>BDC\nq\n/Im0 Do\nQ\nEMC\n`;
    expect(pdfStructureWriterService.hasReadableTextInSpan(content, 0)).toBe(false);
  });

  it('returns false for a span whose only text-show operand is hex/undecodable', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n<0037>Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.hasReadableTextInSpan(content, 0)).toBe(false);
  });

  it('returns false when the MCID cannot be found on this page', () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(X)Tj\nET\nEMC\n`;
    expect(pdfStructureWriterService.hasReadableTextInSpan(content, 999)).toBe(false);
  });
});
