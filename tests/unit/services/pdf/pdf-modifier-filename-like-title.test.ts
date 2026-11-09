/**
 * isFilenameLike / deriveAndSetTitle -- design-tool export filename gap.
 *
 * Real incident: Karsaklian_189165_9781606497623.pdf's /Info/Title was
 * "9781606497623_PRINT.indd" -- the original InDesign export filename,
 * leaked verbatim. The original isFilenameLike extension list only covered
 * document-format filenames (pdf/docx?/txt/epub), never design-tool export
 * formats, so deriveAndSetTitle treated this filename as "already
 * meaningful" and left it untouched -- PAC flagged "Display of document
 * title in window title" (Matterhorn 06-001).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfModifierService, isFilenameLike } from '../../../../src/services/pdf/pdf-modifier.service';

describe('isFilenameLike', () => {
  it('recognizes design-tool export filenames (.indd/.idml/.ai/.psd/.eps/.qxp)', () => {
    expect(isFilenameLike('9781606497623_PRINT.indd')).toBe(true);
    expect(isFilenameLike('cover-art.ai')).toBe(true);
    expect(isFilenameLike('layout.idml')).toBe(true);
    expect(isFilenameLike('background.psd')).toBe(true);
    expect(isFilenameLike('diagram.eps')).toBe(true);
    expect(isFilenameLike('newsletter.qxp')).toBe(true);
  });

  it('still recognizes the pre-existing document-format filenames (regression)', () => {
    expect(isFilenameLike('report.pdf')).toBe(true);
    expect(isFilenameLike('draft.docx')).toBe(true);
    expect(isFilenameLike('notes.txt')).toBe(true);
    expect(isFilenameLike('book.epub')).toBe(true);
    expect(isFilenameLike('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true); // UUID
    expect(isFilenameLike('9798765788493')).toBe(true); // long digit-only code
  });

  it('does not flag a genuinely meaningful title', () => {
    expect(isFilenameLike('Become a Marketing Negotiator')).toBe(false);
    expect(isFilenameLike('The Fundamentals of Negotiation')).toBe(false);
  });
});

describe('deriveAndSetTitle', () => {
  it('replaces a leaked .indd export filename rather than keeping it as "already meaningful"', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.setTitle('9781606497623_PRINT.indd');

    const result = await pdfModifierService.deriveAndSetTitle(doc, 'fallback-filename-stem');

    expect(result.success).toBe(true);
    expect(result.before).toBe('9781606497623_PRINT.indd');
    // No H1 in this minimal test doc's structure tree -- falls through to the filename stem.
    expect(doc.getTitle()).toBe('fallback-filename-stem');
    expect(doc.getTitle()).not.toBe('9781606497623_PRINT.indd');
  });

  it('keeps an already-meaningful existing title untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.setTitle('Become a Marketing Negotiator');

    const result = await pdfModifierService.deriveAndSetTitle(doc, 'fallback-filename-stem');

    expect(result.success).toBe(true);
    expect(doc.getTitle()).toBe('Become a Marketing Negotiator');
  });
});
