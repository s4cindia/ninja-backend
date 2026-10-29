/**
 * Regression coverage for fixTaggedContentInsideArtifact (Matterhorn 01-004
 * fix, added after a real PAC/axesPAC report found 76 real structure
 * elements nested inside /Artifact spans on a document Ninja's own audit
 * had zero coverage for -- see pdf-artifact-tagger.ts's own
 * findTaggedContentInsideArtifact header for the full finding). This
 * writer is a thin per-page wrapper around splitArtifactAroundTaggedContent
 * (already unit-tested directly in pdf-artifact-tagger.test.ts) -- these
 * tests cover the FixResult/AuditIssue plumbing specifically: locating the
 * right page, reporting counts, and failing cleanly when there's nothing
 * left to fix.
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
    severity: 'serious',
    code: 'TAGGED-CONTENT-INSIDE-ARTIFACT',
    message: 'Real structure element(s) nested inside an /Artifact span',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    suggestion: 'Split the enclosing Artifact span so it no longer encloses the real tagged content.',
    category: 'structure',
    pageNumber,
    matterhornCheckpoint: '01-004',
    matterhornHow: 'M',
  } as AuditIssue;
}

describe('fixTaggedContentInsideArtifact', () => {
  it('splits a nested real tag out of its enclosing Artifact and reports success with a count', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n');

    const results = pdfStructureWriterService.fixTaggedContentInsideArtifact(doc, [issueForPage(1)]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].before).toContain('1 real structure element');
    expect(results[0].after).toContain('excised from the Artifact');

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('/Span <</MCID 0 >>BDC\n(x)Tj\nEMC');
    // Still a bare /Artifact BMC, never BDC -- same convention as
    // fixUntaggedContent, same real veraPDF-confirmed hazard avoided.
    expect(fixedContent).not.toContain('/Artifact BDC');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = pdfStructureWriterService.fixTaggedContentInsideArtifact(doc, [issueForPage(undefined)]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('no pageNumber');
  });

  it('fails cleanly when the target page has no Artifact-nested content left (already fixed)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n');

    const results = pdfStructureWriterService.fixTaggedContentInsideArtifact(doc, [issueForPage(1)]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No Artifact-nested real content found');
  });

  it('targets the correct page among several, leaving the others untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePageContent(doc, 1, '/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n');
    writePageContent(doc, 2, '/Artifact BMC\n/Span <</MCID 0 >>BDC\n(y)Tj\nEMC\nEMC\n');

    const results = pdfStructureWriterService.fixTaggedContentInsideArtifact(doc, [issueForPage(2)]);

    expect(results[0].success).toBe(true);
    expect(decodePageContent(doc, 1)).toBe('/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n'); // page 1 untouched
    expect(decodePageContent(doc, 2)).toContain('EMC /Artifact BMC');
  });

  it('never alters the real tag or text/path bytes -- only inserts marked-content boundaries', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const original = '/Artifact BMC\n/Span <</MCID 0 >>BDC\nBT\n9 0 0 9 100 700 Tm\n(Header)Tj\nET\nEMC\nEMC\n';
    writePageContent(doc, 1, original);

    pdfStructureWriterService.fixTaggedContentInsideArtifact(doc, [issueForPage(1)]);

    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('(Header)Tj');
    expect(fixed).toContain('9 0 0 9 100 700 Tm');
  });
});
