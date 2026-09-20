/**
 * Regression coverage for fixUntaggedContent (Matterhorn 01-005 fix, added
 * after the real PAC/axesPAC desktop tool found ~24,000 untagged painted-
 * path regions on a real 377-page document Ninja's own audit had zero
 * coverage for -- see pdf-artifact-tagger.ts's own header for the full
 * finding). This writer is a thin per-page wrapper around
 * tagUntaggedPaintedPaths (already unit-tested directly in
 * pdf-artifact-tagger.test.ts) -- these tests cover the FixResult/AuditIssue
 * plumbing specifically: locating the right page, reporting counts, and
 * failing cleanly when there's nothing left to fix.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: `issue-page-${pageNumber ?? 'none'}`,
    source: 'pdf-structure',
    severity: 'moderate',
    code: 'UNTAGGED-CONTENT',
    message: 'Untagged vector-graphics region(s)',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    suggestion: 'Mark decorative vector graphics as PDF artifacts',
    category: 'structure',
    pageNumber,
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

describe('fixUntaggedContent', () => {
  it('wraps an untagged painted-path region and reports success with a count', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '0 0 m\n10 10 l\nS\n');

    const results = pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(1)]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].before).toContain('1 untagged');
    expect(results[0].after).toContain('marked as /Artifact');

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('/Artifact BMC');
    expect(fixedContent).not.toContain('/Artifact BDC');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(undefined)]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('no pageNumber');
  });

  it('fails cleanly when the target page has no untagged content left (already fixed)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n');

    const results = pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(1)]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No untagged painted-path regions found');
  });

  it('targets the correct page among several, leaving the others untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '0 0 m\n10 10 l\nS\n');
    writePageContent(doc, 2, '20 20 m\n30 30 l\nS\n');

    const results = pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(2)]);

    expect(results[0].success).toBe(true);
    expect(decodePageContent(doc, 1)).toBe('0 0 m\n10 10 l\nS\n'); // page 1 untouched
    expect(decodePageContent(doc, 2)).toContain('/Artifact BMC');
  });

  it('processes multiple page-level issues independently in one call', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '0 0 m\n10 10 l\nS\n');
    writePageContent(doc, 2, '20 20 m\n30 30 l\nS\n');

    const results = pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(1), issueForPage(2)]);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
    expect(decodePageContent(doc, 1)).toContain('/Artifact BMC');
    expect(decodePageContent(doc, 2)).toContain('/Artifact BMC');
  });

  it('never alters path geometry -- only inserts marked-content tags', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const original = '0 0 0 0.7 k\n199.2 729.26 260.4 -19.18 re\nf\n';
    writePageContent(doc, 1, original);

    pdfStructureWriterService.fixUntaggedContent(doc, [issueForPage(1)]);

    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('199.2 729.26 260.4 -19.18 re\nf');
  });
});
